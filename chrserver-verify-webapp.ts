/**
 * chrserver — web-app release sync / serving regression suite.
 *
 *     npx tsx chrserver-verify-webapp.ts
 *
 * Stands up a fake GitHub API (release metadata + the asset download) and a
 * fake chrclient web build (a real zip), then checks the behaviour the
 * operator asked for:
 *
 *   • a fresh server downloads the published build once and serves it,
 *   • starting again with the SAME build downloads nothing — the copy on disk
 *     is served as it is,
 *   • a newer release (new asset id) is downloaded and swapped in,
 *   • GitHub being unreachable does not stop the last good build from serving,
 *   • the express mount serves /, deep links and hashed assets, and never
 *     swallows /api, /auth, /health or /socket.io,
 *   • the checksum / size / zip-safety guards actually reject bad input.
 *
 * No hardware, no database, no real GitHub account needed.
 */
import express from 'express';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
import * as crypto from 'node:crypto';

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    const ok = (label: string, condition: boolean, extra = '') => {
      if (condition) {
        passed += 1;
        console.log(`  ok    ${label}${extra ? ` — ${extra}` : ''}`);
      } else {
        failed += 1;
        console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
      }
    };
    const section = (name: string) => console.log(`\n${name}`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'chr-webapp-verify-'));

    /* ------------------------------------------------------------------ */
    /* a real chrclient web build, as a zip                               */
    /* ------------------------------------------------------------------ */
    const makeWebBuild = (marker: string): Buffer => {
      const zip = new AdmZip();
      zip.addFile(
        'index.html',
        Buffer.from(
          `<!doctype html><html><head><title>AI Crop Robot</title></head><body>` +
            `<div id="root">${marker}</div>` +
            `<script src="/_expo/static/js/web/index-${marker}.js"></script></body></html>`
        )
      );
      zip.addFile('_expo/static/js/web/index-' + marker + '.js', Buffer.from(`console.log("${marker}");`));
      zip.addFile('assets/logo.png', Buffer.from('not-really-a-png-' + marker));
      zip.addFile('favicon.ico', Buffer.from('icon-' + marker));
      zip.addFile('metadata.json', Buffer.from(JSON.stringify({ marker })));
      return zip.toBuffer();
    };

    /* ------------------------------------------------------------------ */
    /* a fake GitHub: release metadata + asset download                   */
    /* ------------------------------------------------------------------ */
    interface Release {
      id: number;
      name: string;
      size: number;
      updatedAt: string;
      digest: string | null;
      zip: Buffer;
    }

    /** Hand-built zip with raw entry names (AdmZip sanitises names when creating). */
const rawZip = (entries: Array<{ name: string; data: string }>): Buffer => {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data, 'utf8');
    const crc = (() => {
      let c = ~0;
      for (const byte of data) {
        c ^= byte;
        for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
      }
      return ~c >>> 0;
    })();
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);      // stored (no compression)
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
};

let downloadCount = 0;
    let apiUp = true;
    let apiMode: 'tag' | 'no-tag' = 'tag';
    let release: Release | null = null;

    const makeRelease = (id: number, marker: string): Release => {
      const zip = makeWebBuild(marker);
      return {
        id,
        name: 'chrclient-web.zip',
        size: zip.length,
        updatedAt: `2026-10-06T10:${String(id).padStart(2, '0')}:00Z`,
        digest: 'sha256:' + crypto.createHash('sha256').update(zip).digest('hex'),
        zip,
      };
    };

    const apiPort = 8791;
    const api = http.createServer((req, res) => {
      if (!apiUp) {
        res.destroy();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${apiPort}`);
      if (url.pathname === '/repos/AlexaInc/chrclient/releases/tags/latest') {
        if (apiMode === 'no-tag' || !release) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Not Found' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            tag_name: 'latest',
            name: 'Latest build (main)',
            prerelease: true,
            assets: [
              {
                id: release.id,
                name: release.name,
                size: release.size,
                updated_at: release.updatedAt,
                digest: release.digest,
                browser_download_url: `http://127.0.0.1:${apiPort}/download/${release.name}`,
              },
            ],
          })
        );
        return;
      }
      if (url.pathname === '/repos/AlexaInc/chrclient/releases') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(release ? [{ tag_name: 'v9.9.9', assets: [
          { id: release.id, name: release.name, size: release.size, updated_at: release.updatedAt,
            digest: release.digest, browser_download_url: `http://127.0.0.1:${apiPort}/download/${release.name}` },
        ] }] : []));
        return;
      }
      if (url.pathname.startsWith('/download/')) {
        if (!release) {
          res.writeHead(404);
          res.end();
          return;
        }
        downloadCount += 1;
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(release.size) });
        res.end(release.zip);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
    });
    await new Promise<void>((resolve) => api.listen(apiPort, '127.0.0.1', resolve));

    /* ------------------------------------------------------------------ */
    /* boot the sync service against that fake GitHub                     */
    /* ------------------------------------------------------------------ */
    const root = path.join(tmpRoot, 'public');
    const stateDir = path.join(tmpRoot, '.webapp');
    process.env.WEBAPP_ENABLED = '1';
    process.env.WEBAPP_REPO = 'AlexaInc/chrclient';
    process.env.WEBAPP_RELEASE_TAG = 'latest';
    process.env.WEBAPP_ASSET_PATTERN = 'chrclient-web';
    process.env.WEBAPP_API_BASE = `http://127.0.0.1:${apiPort}`;
    process.env.WEBAPP_ROOT = root;
    process.env.WEBAPP_STATE_DIR = stateDir;
    process.env.WEBAPP_TIMEOUT_MS = '4000';

    const { WebAppRelease } = await import('./src/services/WebAppRelease');
    const sync = WebAppRelease.getInstance();

    const readIndex = () => (fs.existsSync(path.join(root, 'index.html')) ? fs.readFileSync(path.join(root, 'index.html'), 'utf8') : '');

    section('1 · first start: download and publish');
    release = makeRelease(11, 'build11');
    let status = await sync.check(false);
    ok('status is "updated"', status.lastResult === 'updated', status.lastResult);
    ok('download happened exactly once', downloadCount === 1, `downloads=${downloadCount}`);
    ok('index.html is in place', sync.hasIndex());
    ok('served build is the downloaded one', readIndex().includes('build11'));
    ok('hashed asset was unpacked', fs.existsSync(path.join(root, '_expo/static/js/web/index-build11.js')));
    ok('file count recorded', status.files === 5, `files=${status.files}`);
    ok('sha256 recorded', (status.sha256 ?? '').length === 64, (status.sha256 ?? '').slice(0, 12) + '…');
    ok('fingerprint exposed', status.stateFingerprint === `11:${release.size}:${release.updatedAt}`, String(status.stateFingerprint));

    section('2 · restart with the same release: NO download, serve what is there');
    const before = fs.readFileSync(path.join(root, 'index.html'));
    status = await sync.check(false);
    ok('status is "unchanged"', status.lastResult === 'unchanged', status.lastResult);
    ok('asset was NOT downloaded again', downloadCount === 1, `downloads=${downloadCount}`);
    ok('served file is untouched', fs.readFileSync(path.join(root, 'index.html')).equals(before));
    ok('checks counter advanced', status.checks >= 2, `checks=${status.checks}`);

    section('3 · a newer release: download + atomic swap');
    release = makeRelease(12, 'build12');
    status = await sync.check(false);
    ok('status is "updated"', status.lastResult === 'updated', status.lastResult);
    ok('downloaded the new build', downloadCount === 2, `downloads=${downloadCount}`);
    ok('served build is the new one', readIndex().includes('build12'));
    ok('old build files are gone', !fs.existsSync(path.join(root, '_expo/static/js/web/index-build11.js')));
    ok('new asset id recorded', status.assetId === 12, String(status.assetId));

    section('4 · GitHub unreachable: keep serving the last good build');
    apiUp = false;
    status = await sync.check(false);
    ok('status reports offline', status.lastResult === 'offline', status.lastResult);
    ok('error is recorded', !!status.lastError, status.lastError ?? '');
    ok('still serving the previous build', readIndex().includes('build12'));
    ok('no extra download', downloadCount === 2, `downloads=${downloadCount}`);
    apiUp = true;
    status = await sync.check(false);
    ok('recovers when GitHub is back and stays unchanged', status.lastResult === 'unchanged', status.lastResult);

    section('5 · release tagged "latest" missing → falls back to the newest release with a web build');
    apiMode = 'no-tag';
    status = await sync.check(false);
    ok('still resolves a build', status.lastResult === 'unchanged', status.lastResult);
    apiMode = 'tag';

    section('6 · guards: wrong checksum and unsafe zip entries are refused');
    release = makeRelease(13, 'build13');
    const goodDigest = release.digest;
    release.digest = 'sha256:' + 'f'.repeat(64);
    status = await sync.check(false);
    ok('checksum mismatch rejected', status.lastResult === 'error' && /checksum mismatch/i.test(status.lastError ?? ''), status.lastError ?? '');
    ok('served build was NOT replaced', readIndex().includes('build12'));
    release.digest = goodDigest;
    status = await sync.check(false);
    ok('recovers once the checksum is right', status.lastResult === 'updated' && readIndex().includes('build13'), status.lastResult);

    const evilBuff = rawZip([
      { name: 'index.html', data: 'evil' },
      { name: '../escape.txt', data: 'nope' },
      { name: 'sub/../../escape2.txt', data: 'nope' },
    ]);
    const evilRelease: Release = {
      id: 14, name: 'chrclient-web.zip', size: evilBuff.length, updatedAt: '2026-10-06T11:14:00Z',
      digest: null, zip: evilBuff,
    };
    release = evilRelease;
    status = await sync.check(false);
    ok('zip-slip entry refused', status.lastResult === 'error' && /unsafe zip entry/i.test(status.lastError ?? ''), `${status.lastResult} / ${status.lastError ?? ''}`);
    ok('nothing escaped the target folder', !fs.existsSync(path.join(tmpRoot, 'escape.txt')));
    ok('previous build still served', readIndex().includes('build13'), readIndex().slice(0, 90));

    section('7 · invalid build (no index.html) refused');
    const noIndex = new AdmZip();
    noIndex.addFile('readme.txt', Buffer.from('not a web build'));
    const noIndexBuff = noIndex.toBuffer();
    release = { id: 15, name: 'chrclient-web.zip', size: noIndexBuff.length, updatedAt: '2026-10-06T11:15:00Z', digest: null, zip: noIndexBuff };
    status = await sync.check(false);
    ok('refused without index.html', status.lastResult === 'error' && /no index\.html/i.test(status.lastError ?? ''), `${status.lastResult} / ${status.lastError ?? ''}`);
    ok('previous build still served', readIndex().includes('build13'), readIndex().slice(0, 90));

    section('8 · serving: express mount behaves like a web server');
    release = makeRelease(16, 'build16');
    await sync.check(false);

    const app = express();
    app.get('/health', (_req, res) => res.send({ ok: true }));
    app.get('/api/config', (_req, res) => res.send({ ok: true, api: 'config' }));
    app.post('/api/robot/command', (_req, res) => res.send({ ok: true, api: 'robot' }));
    sync.mount(app); // exactly how server.ts mounts it: after every API route

    const webPort = 8792;
    const server = app.listen(webPort, '127.0.0.1');
    await sleep(120);
    const get = async (p: string, accept = 'text/html') => {
      const res = await fetch(`http://127.0.0.1:${webPort}${p}`, { headers: { accept } });
      const body = await res.text();
      return { status: res.status, body, headers: res.headers };
    };

    let r = await get('/');
    ok('GET / serves the web app', r.status === 200 && r.body.includes('build16'), `status=${r.status}`);
    ok('index.html is served as html', (r.headers.get('content-type') ?? '').includes('text/html'));
    ok('index.html is not cached hard', (r.headers.get('cache-control') ?? '').includes('no-cache'), r.headers.get('cache-control') ?? '');

    r = await get('/robot');
    ok('SPA deep link /robot returns the app', r.status === 200 && r.body.includes('build16'), `status=${r.status}`);

    r = await get('/_expo/static/js/web/index-build16.js', '*/*');
    ok('hashed bundle is served', r.status === 200 && r.body.includes('build16'), `status=${r.status}`);
    ok('hashed bundle is immutable-cached', (r.headers.get('cache-control') ?? '').includes('immutable'), r.headers.get('cache-control') ?? '');

    r = await get('/api/config', 'application/json');
    ok('/api/config still answers the API (not the web app)', r.status === 200 && r.body.includes('"api":"config"'), r.body.slice(0, 40));
    r = await get('/api/does-not-exist', 'application/json');
    ok('/api/* unknown paths do NOT fall back to index.html', r.status === 404, `status=${r.status}`);
    r = await get('/health', 'application/json');
    ok('/health still answers', r.status === 200 && r.body.includes('"ok":true'));
    const post = await fetch(`http://127.0.0.1:${webPort}/api/robot/command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    ok('POST routes are untouched by the static mount', post.status === 200);

        section('9 · a server with no build yet answers a helpful 503');
    const emptyRoot = path.join(tmpRoot, 'empty-public');
    await fsp.mkdir(emptyRoot, { recursive: true });
    const prevRoot = process.env.WEBAPP_ROOT;
    process.env.WEBAPP_ROOT = emptyRoot;
    const emptySync = new (WebAppRelease as any)();      // fresh instance, empty folder
    process.env.WEBAPP_ROOT = prevRoot;
    const empty = express();
    emptySync.mount(empty);
    const emptyPort = 8793;
    const emptyServer = empty.listen(emptyPort, '127.0.0.1');
    await sleep(80);
    const emptyRes = await fetch(`http://127.0.0.1:${emptyPort}/`, { headers: { accept: 'text/html' } });
    const emptyBody = await emptyRes.text();
    ok('503 with an explanation', emptyRes.status === 503 && /web build not ready/i.test(emptyBody), `status=${emptyRes.status}`);
    ok('the page shows the status link', emptyBody.includes('/api/webapp'));

section('10 · status payload (what /api/webapp and /health report)');
    const final = sync.getStatus();
    ok('serving flag true', final.serving === true);
    ok('installs counter counts only accepted builds', final.downloads === 4, `installs=${final.downloads}`);
    ok('mock saw every attempt, failures included', downloadCount === 7, `requests=${downloadCount}`);
    ok('no stray staging folders are left behind',
      fs.readdirSync(path.join(tmpRoot, '.webapp')).filter((f) => f.startsWith('build-')).length === 0,
      fs.readdirSync(path.join(tmpRoot, '.webapp')).join(','));
    ok('counters + filenames exposed', final.assetName === 'chrclient-web.zip' && final.tag === 'latest', `${final.assetName}@${final.tag}`);
    ok('keeps the previous good build when a refresh fails', final.lastResult === 'updated' && final.files === 5, `${final.lastResult}/${final.files}`);

    server.close();
    emptyServer.close();
    api.close();
    await fsp.rm(tmpRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) {
      console.log('❌ web-app serving checks failed');
      process.exit(1);
    }
    console.log('🎉 all web-app serving checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
