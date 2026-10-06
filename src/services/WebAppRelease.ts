import AdmZip from "adm-zip";
import express, { Express, NextFunction, Request, Response } from "express";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { logger } from "../logger";

/**
 * Serves the newest chrclient **web** build from this server.
 *
 * On startup (and optionally every `WEBAPP_CHECK_INTERVAL_MS`) the release
 * published by the chrclient CI is inspected:
 *
 *   GET {api}/repos/{repo}/releases/tags/{tag}      (tag defaults to "latest")
 *
 * The release asset (chrclient-web*.zip) is fingerprinted by
 * `asset.id + size + updated_at`. If the copy already on disk has the same
 * fingerprint and `index.html` is there, **nothing is downloaded** — the
 * existing folder is served as it is. Only when the fingerprint differs is the
 * asset downloaded, checksum-verified, unpacked next to the live folder and
 * swapped in atomically (`public` ← extracted copy), so a running server never
 * serves a half-written build.
 *
 * If GitHub is unreachable the last good copy keeps being served; the status
 * object (GET /api/webapp, GET /health) says what happened.
 */

export interface WebAppAssetState {
  tag: string;
  assetId: number | null;
  assetName: string | null;
  size: number;
  assetUpdatedAt: string | null;
  sha256: string | null;
  downloadedAt: string | null;
  files: number;
}

export type WebAppResult =
  | "idle"
  | "unchanged"
  | "updated"
  | "offline"
  | "not-found"
  | "disabled"
  | "error";

export interface WebAppStatus extends WebAppAssetState {
  enabled: boolean;
  repo: string;
  releaseTag: string;
  assetPattern: string;
  root: string;
  serving: boolean;
  stateFingerprint: string | null;
  lastCheckAt: string | null;
  lastResult: WebAppResult;
  lastError: string | null;
  checks: number;
  downloads: number;
}

/** The asset downloaded fine but is not a usable web build (checksum, entries, index.html). */
class WebAppBuildError extends Error {
  readonly code = "BUILD_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "WebAppBuildError";
  }
}

const env = (key: string, fallback: string): string => {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
};
const envFlag = (key: string, fallback: boolean): boolean => {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
};
const envNum = (key: string, fallback: number): number => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
};

export class WebAppRelease {
  private static instance: WebAppRelease | null = null;

  static getInstance(): WebAppRelease {
    if (!WebAppRelease.instance) WebAppRelease.instance = new WebAppRelease();
    return WebAppRelease.instance;
  }

  /** Default repository that publishes the web build (chrclient CI). */
  readonly repo: string = env("WEBAPP_REPO", "AlexaInc/chrclient");
  readonly releaseTag: string = env("WEBAPP_RELEASE_TAG", "latest");
  readonly assetPattern: string = env("WEBAPP_ASSET_PATTERN", "chrclient-web");
  readonly apiBase: string = env("WEBAPP_API_BASE", "https://api.github.com").replace(/\/$/, "");
  readonly enabled: boolean = envFlag("WEBAPP_ENABLED", true);
  readonly root: string = path.resolve(env("WEBAPP_ROOT", "public"));
  readonly stateDir: string = path.resolve(env("WEBAPP_STATE_DIR", ".webapp"));
  readonly intervalMs: number = envNum("WEBAPP_CHECK_INTERVAL_MS", 0);
  readonly timeoutMs: number = envNum("WEBAPP_TIMEOUT_MS", 30_000);
  private readonly token: string = env("WEBAPP_TOKEN", env("GITHUB_TOKEN", ""));
  private readonly fallbackToNewest: boolean = envFlag("WEBAPP_FALLBACK_TO_NEWEST", true);

  private readonly stateFile = path.join(this.stateDir, "release.json");
  private state: WebAppAssetState = {
    tag: "",
    assetId: null,
    assetName: null,
    size: 0,
    assetUpdatedAt: null,
    sha256: null,
    downloadedAt: null,
    files: 0,
  };
  private lastCheckAt: string | null = null;
  private lastResult: WebAppResult = "idle";
  private lastError: string | null = null;
  private checks = 0;
  private downloads = 0;
  private inFlight: Promise<WebAppStatus> | null = null;

  private constructor() {
    this.loadState();
  }

  /* ------------------------------------------------------------------ */
  /* state                                                              */
  /* ------------------------------------------------------------------ */

  private loadState(): void {
    try {
      const raw = fs.readFileSync(this.stateFile, "utf8");
      const parsed = JSON.parse(raw) as Partial<WebAppAssetState>;
      this.state = { ...this.state, ...parsed };
    } catch {
      /* first run — no state yet */
    }
  }

  private async saveState(): Promise<void> {
    await fsp.mkdir(this.stateDir, { recursive: true });
    await fsp.writeFile(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  private fingerprintOf(assetId: number | null, size: number, updatedAt: string | null): string | null {
    return assetId === null ? null : `${assetId}:${size}:${updatedAt ?? ""}`;
  }

  private stateFingerprint(): string | null {
    return this.fingerprintOf(this.state.assetId, this.state.size, this.state.assetUpdatedAt);
  }

  get indexFile(): string {
    return path.join(this.root, "index.html");
  }

  hasIndex(): boolean {
    try {
      return fs.statSync(this.indexFile).isFile();
    } catch {
      return false;
    }
  }

  getStatus(): WebAppStatus {
    return {
      enabled: this.enabled,
      repo: this.repo,
      releaseTag: this.releaseTag,
      assetPattern: this.assetPattern,
      root: this.root,
      serving: this.hasIndex(),
      stateFingerprint: this.stateFingerprint(),
      lastCheckAt: this.lastCheckAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      checks: this.checks,
      downloads: this.downloads,
      ...this.state,
    };
  }

  /* ------------------------------------------------------------------ */
  /* startup / loop                                                     */
  /* ------------------------------------------------------------------ */

  start(): void {
    if (!this.enabled) {
      this.lastResult = "disabled";
      logger.info("[WEBAPP] release sync disabled (WEBAPP_ENABLED=false)");
      return;
    }
    logger.info(
      `[WEBAPP] watching ${this.repo}@${this.releaseTag} → ${this.root}` +
        (this.hasIndex() ? ` (current copy: ${this.state.tag || "unknown"}${this.state.downloadedAt ? ", " + this.state.downloadedAt : ""})` : " (no local copy yet)")
    );
    // never block startup: the server serves whatever is on disk while this runs
    void this.check(false);
    if (this.intervalMs > 0) {
      const timer = setInterval(() => void this.check(false), this.intervalMs);
      timer.unref?.();
      logger.info(`[WEBAPP] re-checking every ${Math.round(this.intervalMs / 1000)}s`);
    }
  }

  /** One pass; `force` re-downloads even when the fingerprint already matches. */
  check(force = false): Promise<WebAppStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runCheck(force).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCheck(force: boolean): Promise<WebAppStatus> {
    if (!this.enabled) {
      this.lastResult = "disabled";
      return this.getStatus();
    }
    this.checks += 1;
    this.lastCheckAt = new Date().toISOString();
    try {
      const asset = await this.findAsset();
      const remoteFp = this.fingerprintOf(asset.id, asset.size, asset.updatedAt);

      if (!force && remoteFp !== null && remoteFp === this.stateFingerprint() && this.hasIndex()) {
        // The important case: the newest build is already on disk → no download.
        this.lastResult = "unchanged";
        this.lastError = null;
        logger.info(
          `[WEBAPP] already up to date — ${this.state.assetName ?? this.assetPattern} (${this.prettySize(asset.size)}, ${asset.updatedAt}), serving ${this.root}`
        );
        return this.getStatus();
      }

      logger.info(
        `[WEBAPP] ${this.state.assetId === null ? "no local copy" : "newer build"} → downloading ${asset.name} (${this.prettySize(asset.size)})`
      );
      const { buffer, sha256 } = await this.download(asset.url, asset.size);

      if (asset.digest) {
        const expected = asset.digest.replace(/^sha256:/, "");
        if (expected.length === 64 && expected !== sha256) {
          throw new WebAppBuildError(`checksum mismatch (github reports ${expected.slice(0, 12)}…, downloaded ${sha256.slice(0, 12)}…)`);
        }
      }

      const files = await this.unpack(buffer, asset, sha256);
      this.state = {
        tag: asset.releaseTag,
        assetId: asset.id,
        assetName: asset.name,
        size: asset.size,
        assetUpdatedAt: asset.updatedAt,
        sha256,
        downloadedAt: new Date().toISOString(),
        files,
      };
      await this.saveState();
      this.downloads += 1;
      this.lastResult = "updated";
      this.lastError = null;
      logger.info(
        `[WEBAPP] updated: ${asset.name} (${asset.releaseTag}) → ${files} files in ${this.root} (sha256 ${sha256.slice(0, 12)}…)`
      );
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      const code = (error as { code?: string } | null)?.code;
      if (code === "NOT_FOUND") {
        this.lastResult = "not-found";
        logger.warn(`[WEBAPP] no web build published for ${this.repo}@${this.releaseTag} yet (${message})`);
      } else if (code === "BUILD_INVALID") {
        // The download itself worked but the build is unusable (checksum, zip
        // entries, missing index.html). Report it as an error — it is not a
        // network problem and the operator should look at the release.
        this.lastResult = "error";
        logger.error(`[WEBAPP] rejecting the published build: ${message}${this.hasIndex() ? " — keeping the copy already in " + this.root : ""}`);
      } else if (this.hasIndex()) {
        // GitHub unreachable / rate limited: keep serving the last good copy.
        this.lastResult = "offline";
        logger.warn(`[WEBAPP] could not refresh (${message}) — still serving the existing copy in ${this.root}`);
      } else {
        this.lastResult = "error";
        logger.error(`[WEBAPP] could not fetch a web build: ${message}`);
      }
      return this.getStatus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* GitHub                                                             */
  /* ------------------------------------------------------------------ */

  private headers(accept: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: accept,
      "User-Agent": "chrserver-webapp-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  private async fetchJson(url: string): Promise<any> {
    const res = await fetch(url, { headers: this.headers("application/vnd.github+json"), signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 404) {
      const err = new Error(`404 from ${url}`);
      (err as any).code = "NOT_FOUND";
      throw err;
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    return res.json();
  }

  private pickAsset(release: any): any {
    const assets: any[] = Array.isArray(release?.assets) ? release.assets : [];
    const zips = assets.filter((a) => typeof a?.name === "string" && /\.zip$/i.test(a.name) && a.name.startsWith(this.assetPattern));
    if (!zips.length) {
      const err = new Error(`release ${release?.tag_name ?? "?"} has no ${this.assetPattern}*.zip asset`);
      (err as any).code = "NOT_FOUND";
      throw err;
    }
    // exact name first (chrclient-web.zip), otherwise the newest of the set
    const exact = zips.find((a) => a.name === `${this.assetPattern}.zip`);
    if (exact) return exact;
    return zips.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")))[0];
  }

  private async findAsset(): Promise<{
    id: number | null;
    name: string;
    size: number;
    updatedAt: string | null;
    url: string;
    digest: string | null;
    releaseTag: string;
  }> {
    try {
      const release = await this.fetchJson(`${this.apiBase}/repos/${this.repo}/releases/tags/${encodeURIComponent(this.releaseTag)}`);
      const a = this.pickAsset(release);
      return this.toAsset(a, release?.tag_name ?? this.releaseTag);
    } catch (error) {
      const isNotFound = (error as { code?: string } | null)?.code === "NOT_FOUND";
      if (!isNotFound || !this.fallbackToNewest) throw error;
      // No release under that tag (yet): fall back to the newest release that
      // carries a web build, which is what a fresh repo/tag produces.
      const releases = await this.fetchJson(`${this.apiBase}/repos/${this.repo}/releases?per_page=20`);
      for (const release of Array.isArray(releases) ? releases : []) {
        try {
          const a = this.pickAsset(release);
          logger.info(`[WEBAPP] no release tagged "${this.releaseTag}"; using release ${release.tag_name}`);
          return this.toAsset(a, release.tag_name);
        } catch {
          /* this release has no web asset — try the next one */
        }
      }
      const err = new Error(`no release of ${this.repo} carries a ${this.assetPattern}*.zip asset`);
      (err as any).code = "NOT_FOUND";
      throw err;
    }
  }

  private toAsset(asset: any, releaseTag: string) {
    return {
      id: typeof asset.id === "number" ? asset.id : null,
      name: String(asset.name),
      size: Number(asset.size) || 0,
      updatedAt: asset.updated_at ? String(asset.updated_at) : null,
      url: String(asset.browser_download_url ?? asset.url),
      digest: typeof asset.digest === "string" ? asset.digest : null,
      releaseTag,
    };
  }

  private async download(url: string, expectedSize: number): Promise<{ buffer: Buffer; sha256: string }> {
    // A token makes private repos work; browser_download_url accepts it too.
    const res = await fetch(url, { headers: this.headers("application/octet-stream"), signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} downloading ${url}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length) throw new WebAppBuildError("downloaded asset is empty");
    if (expectedSize && buffer.length !== expectedSize) {
      throw new WebAppBuildError(`size mismatch: expected ${expectedSize} bytes, got ${buffer.length}`);
    }
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    return { buffer, sha256 };
  }

  /* ------------------------------------------------------------------ */
  /* unpack + atomic swap                                               */
  /* ------------------------------------------------------------------ */

  private async unpack(buffer: Buffer, asset: { name: string }, sha256: string): Promise<number> {
    const tmpDir = path.join(this.stateDir, "tmp");
    const staging = path.join(tmpDir, `build-${Date.now()}`);
    const previous = path.join(tmpDir, "previous");
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });

    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();
    if (!entries.length) throw new WebAppBuildError(`${asset.name} is not a readable zip`);

    let files = 0;
    for (const entry of entries) {
      const name = entry.entryName.replace(/\\/g, "/");
      // zip-slip guard: never write outside the staging folder
      if (name.startsWith("/") || name.split("/").includes("..") || /^[a-zA-Z]:/.test(name)) {
        throw new WebAppBuildError(`refusing unsafe zip entry "${entry.entryName}"`);
      }
      const target = path.join(staging, name);
      if (!target.startsWith(staging + path.sep) && target !== staging) {
        throw new WebAppBuildError(`refusing zip entry outside the target folder: "${entry.entryName}"`);
      }
      if (entry.isDirectory) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, entry.getData());
      files += 1;
    }

    if (!fs.existsSync(path.join(staging, "index.html"))) {
      throw new WebAppBuildError(`${asset.name} contains no index.html — is this really the web build?`);
    }

    // Swap: move the current folder aside, move the new one in, drop the old.
    await fsp.rm(previous, { recursive: true, force: true });
    const hadPrevious = this.hasIndex() || fs.existsSync(this.root);
    if (hadPrevious) await fsp.rename(this.root, previous).catch(async () => {
      await fsp.cp(this.root, previous, { recursive: true });
      await fsp.rm(this.root, { recursive: true, force: true });
    });
    try {
      await fsp.rename(staging, this.root);
    } catch (error) {
      // last resort (e.g. cross-device or a locked folder): copy instead
      await fsp.cp(staging, this.root, { recursive: true });
      await fsp.rm(staging, { recursive: true, force: true });
    }
    await fsp.rm(previous, { recursive: true, force: true });
    logger.info(`[WEBAPP] build ${asset.name} verified (sha256 ${sha256.slice(0, 12)}…) and swapped in`);
    return files;
  }

  /* ------------------------------------------------------------------ */
  /* serving                                                            */
  /* ------------------------------------------------------------------ */

  /** Paths that belong to the API/robot side and must never fall back to the web app. */
  private static readonly RESERVED = ["/api", "/auth", "/health", "/socket.io", "/whatsapp"];

  private static isReserved(p: string): boolean {
    return WebAppRelease.RESERVED.some((r) => p === r || p.startsWith(r + "/"));
  }

  private static cacheHeaders(res: Response, filePath: string): void {
    const rel = filePath.replace(/\\/g, "/");
    if (rel.includes("/_expo/static/") || rel.includes("/assets/")) {
      // content-hashed file names — safe to cache hard
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      // index.html / metadata.json / favicon: always revalidate, so a new
      // release shows up without the operator clearing anything
      res.setHeader("Cache-Control", "no-cache");
    }
  }

  /**
   * Mounts the web app on the express app. Call this AFTER every API route:
   * it only answers paths the API did not claim.
   */
  mount(app: Express): void {
    const self = this;
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (WebAppRelease.isReserved(req.path)) return next();
      express.static(self.root, {
        index: ["index.html"],
        etag: true,
        lastModified: true,
        fallthrough: true,
        setHeaders: (res, filePath) => WebAppRelease.cacheHeaders(res, filePath),
      })(req, res, next);
    });

    // SPA deep links (/robot, /settings …) hand back index.html
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (WebAppRelease.isReserved(req.path)) return next();
      const wantsHtml = (req.headers.accept ?? "").includes("text/html");
      if (!wantsHtml) return next();
      if (!self.hasIndex()) {
        res
          .status(503)
          .type("html")
          .send(
            `<!doctype html><meta charset="utf-8"><title>AI Crop Robot — web build not ready</title>` +
              `<body style="font-family:system-ui;background:#043622;color:#d1fae5;padding:40px">` +
              `<h1 style="margin:0 0 8px">Web build not ready yet</h1>` +
              `<p>The server has not published a chrclient web build into <code>${self.root}</code>.</p>` +
              `<p>Status: <a style="color:#6ee7b7" href="/api/webapp">/api/webapp</a> · ` +
              (self.lastError ? `last error: <code>${escapeHtml(self.lastError)}</code>` : "no error logged") +
              `</p><p>Set <code>GITHUB_TOKEN</code> if the repository is private, then restart.</p></body>`
          );
        return;
      }
      res.setHeader("Cache-Control", "no-cache");
      res.sendFile(self.indexFile);
    });
  }

  private prettySize(bytes: number): string {
    if (!bytes) return "unknown size";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

export default WebAppRelease;
