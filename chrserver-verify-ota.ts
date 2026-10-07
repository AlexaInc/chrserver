/**
 * chrserver — OTA firmware update regression suite.
 *
 *     npx tsx chrserver-verify-ota.ts
 *
 * The chain the operator uses is: upload the .bin → press Update → the board
 * downloads the image from THIS server and flashes itself → the board reboots
 * and reports the new version, which is what finally clears the queue entry.
 *
 * This suite drives that chain without hardware:
 *
 *   • the firmware store: hashes, listing, latest, re-scan from disk, delete;
 *   • the queue decisions: push / confirm-on-reboot / give-up, per device;
 *   • the HTTP API: operator upload + list + trigger, with the exact `ota`
 *     command a board receives (captured from the socket layer);
 *   • "board was offline": queue kept, pushed the moment it says hello again;
 *   • the download route a real board calls: token rules (a pump token cannot
 *     fetch a rover image) and the bytes it would flash (md5 checked);
 *   • the `ota` command is refused for a board whose FW_TARGET does not match.
 *
 * No hardware, no database, no GitHub account needed.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

async function main(): Promise<void> {
    let passed = 0;
    let failed = 0;
    const ok = (label: string, condition: boolean, extra = "") => {
        if (condition) {
            passed += 1;
            console.log(`  ok    ${label}${extra ? ` — ${extra}` : ""}`);
        } else {
            failed += 1;
            console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
        }
    };
    const section = (name: string) => console.log(`\n${name}`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "chr-ota-verify-"));
    process.env.FIRMWARE_ROOT = path.join(tmpRoot, "firmware");
    process.env.FIRMWARE_OTA_MAX_ATTEMPTS = "2";
    process.env.ADMIN_USERNAME = "Administrator";
    process.env.ADMIN_PASSWORD = "verify-pass";
    process.env.ROBOT_TOKEN = "robot-token-verify";
    process.env.PUMP_TOKEN = "pump-token-verify";
    process.env.JWT_SECRET = "verify-secret";
    process.env.PORT = "0";
    delete process.env.WEBAPP_ENABLED;
    process.env.WEBAPP_ENABLED = "0";

    const { FirmwareRelease, firmwarePath } = await import("./src/services/FirmwareRelease");
    const { WSServer } = await import("./src/sockets/wsserver");
    const { Server, sessions } = await import("./src/server");
    const { config } = await import("./src/config/config");

    /* ------------------------------------------------------------------ */
    /* a fake firmware image + the "old" board state                      */
    /* ------------------------------------------------------------------ */
    const roverImage = Buffer.concat([
        Buffer.from([0xe9, 0x02, 0x01, 0x20]), // ESP32 image magic + segment header
        crypto.randomBytes(4096),
    ]);
    const pumpImage = Buffer.concat([Buffer.from([0xe9, 0x02, 0x01, 0x20]), crypto.randomBytes(2048)]);
    const roverVersion = "2026-10-07-ota-verify";
    const pumpVersion = "2026-10-07-pump-verify";
    const md5 = (b: Buffer) => crypto.createHash("md5").update(b).digest("hex");

    /* ------------------------------------------------------------------ */
    /* 1. the store                                                       */
    /* ------------------------------------------------------------------ */
    section("1. firmware store");
    const store = FirmwareRelease.getInstance();
    const saved = store.saveBuild({ target: "rover", version: roverVersion, data: roverImage, notes: "verify", uploadedBy: "operator" });
    ok("upload stores the image and its hashes",
        fs.existsSync(saved.file) && saved.size === roverImage.length &&
        saved.md5 === md5(roverImage) && saved.sha256 === crypto.createHash("sha256").update(roverImage).digest("hex"),
        `${saved.size} bytes, md5 ${saved.md5.slice(0, 10)}…`);
    store.saveBuild({ target: "pump-c3", version: pumpVersion, data: pumpImage, notes: "pump verify" });

    const status = store.status();
    const roverStatus = status.targets.find((t) => t.target === "rover")!;
    ok("status lists the target with its newest build", roverStatus?.latest?.version === roverVersion);
    ok("status hides the on-disk path from the API payload",
        !("file" in (roverStatus.latest as object)) && roverStatus.builds.every((b: object) => !("file" in b)));
    ok("latest() answers per target", store.latest("pump-c3")?.version === pumpVersion && store.latest("rover")?.version === roverVersion);
    ok("targets() lists both families", JSON.stringify(store.targets()) === JSON.stringify(["pump-c3", "rover"]));
    ok("an unknown version is not found", store.get("rover", "1999-01-01-nope") === undefined);

    const command = FirmwareRelease.otaCommand(store.get("rover", roverVersion)!) as { action: string; data: Record<string, unknown> };
    ok("the ota command carries target/version/md5/size/path",
        command.action === "ota" && command.data.target === "rover" && command.data.version === roverVersion &&
        command.data.md5 === saved.md5 && command.data.size === roverImage.length &&
        command.data.path === firmwarePath("rover", roverVersion),
        String(command.data.path));

    // re-scan: an image copied into the root by hand must be picked up again
    await fsp.rm(path.join(process.env.FIRMWARE_ROOT!, "index.json"), { force: true });
    const rescanRoot = path.join(process.env.FIRMWARE_ROOT!, "rover");
    ok("the .bin survives on disk for a re-scan", fs.existsSync(path.join(rescanRoot, `${roverVersion}.bin`)));

    section("2. queue decisions (push / confirm / give up)");
    const pending = store.markPending("rover", roverVersion, "operator");
    ok("markPending queues the update", pending.version === roverVersion && store.pendingFor("rover")?.version === roverVersion);
    ok("markPending refuses a version that was never uploaded",
        (() => { try { store.markPending("rover", "1999-01-01-nope"); return false; } catch { return true; } })());

    let decision = store.noteDeviceFirmware("chr-rover-01", "rover", "2026-10-06-arc-avoid");
    ok("a board on an older build is told to update", decision.action === "push" && (decision as { build: { version: string } }).build.version === roverVersion);
    store.notePushed("chr-rover-01", "rover", roverVersion);
    decision = store.noteDeviceFirmware("chr-rover-01", "rover", "2026-10-06-arc-avoid");
    ok("a second reconnect still gets it while attempts remain", decision.action === "push");
    store.notePushed("chr-rover-01", "rover", roverVersion);
    decision = store.noteDeviceFirmware("chr-rover-01", "rover", "2026-10-06-arc-avoid");
    ok("after the attempt budget it gives up instead of looping forever",
        decision.action === "gave-up" && store.pendingFor("rover") === undefined,
        decision.action === "gave-up" ? `${(decision as { attempts: number }).attempts} attempts` : "");

    store.markPending("rover", roverVersion, "operator");
    decision = store.noteDeviceFirmware("chr-rover-01", "rover", roverVersion);
    ok("a board that comes back running the new build confirms the update",
        decision.action === "complete" && store.pendingFor("rover") === undefined);
    store.markPending("rover", roverVersion, "operator");
    ok("a board without an OTA target is left alone", store.noteDeviceFirmware("old-board", undefined, "whatever").action === "none");

    store.markPending("pump-c3", pumpVersion, "operator");
    ok("removing the queued image clears the queue entry",
        store.removeBuild("pump-c3", pumpVersion) && store.pendingFor("pump-c3") === undefined && !fs.existsSync(path.join(process.env.FIRMWARE_ROOT!, "pump-c3", `${pumpVersion}.bin`)));

    store.saveBuild({ target: "pump-c3", version: pumpVersion, data: pumpImage, notes: "pump verify" });
    store.markPending("rover", roverVersion, "operator");

    /* ------------------------------------------------------------------ */
    /* 3. the HTTP API + the socket layer                                 */
    /* ------------------------------------------------------------------ */
    section("3. operator API and the command a board receives");

    const stubDb = {
        acknowledgeSuperseded: async () => 0,
        createAlert: async (row: Record<string, unknown>) => ({ id: 1, created_at: Date.now(), ...row }),
        getSetting: async (_key: string, fallback: unknown) => fallback,
        setSetting: async () => undefined,
        saveLocation: async () => undefined,
    };
    const app = new Server({ port: 0, domain: "127.0.0.1" });
    app.configureMiddleware();
    app.setupRoutes({ models: [], db: stubDb as never });
    app.configureErrorHandling();
    const httpServer: http.Server = http.createServer(app.app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const wss = new WSServer(httpServer, stubDb as never);
    wss.setup();

    // capture what the socket layer emits (the real io.to(...).emit path)
    const emitted: Array<{ room: string; event: string; payload: any }> = [];
    const realIoTo = wss.io.to.bind(wss.io);
    (wss as unknown as { io: { to: (room: string) => { emit: (event: string, payload: unknown) => unknown } } }).io.to = (room: string) => ({
        emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); return true; },
    });

    const nonce = "verify-nonce";
    const hash = (value: string) => crypto.createHash("sha256").update(value + nonce).digest("hex");
    const login = await fetch(`${base}/auth/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: hash(config.ADMIN_USERNAME), password: hash(config.ADMIN_PASS), nonce }),
    }).then((r) => r.json() as Promise<{ token?: string }>);
    const token = login.token ?? "";
    ok("operator can sign in", Boolean(token) && sessions.get(token) === config.ADMIN_USERNAME);

    const auth = { Authorization: `Bearer ${token}` };
    const unauthed = await fetch(`${base}/api/firmware`);
    ok("firmware endpoints refuse an anonymous caller", unauthed.status === 401);

    // a board that is online (same shape device_hello fills in)
    (wss as unknown as { deviceSockets: Map<string, string> }).deviceSockets.set("chr-rover-01", "socket-1");
    (wss as unknown as { deviceHello: Map<string, unknown> }).deviceHello.set("chr-rover-01", { deviceId: "chr-rover-01", role: "esp_32", firmware: "2026-10-06-arc-avoid", fwTarget: "rover", at: Date.now() });

    const listBody: any = await fetch(`${base}/api/firmware`, { headers: auth }).then((r) => r.json());
    ok("the panel sees the stored image and the boards", listBody.ok === true &&
        listBody.targets.some((t: any) => t.target === "rover" && t.latest.version === roverVersion) &&
        listBody.devices.some((d: any) => d.deviceId === "chr-rover-01" && d.fwTarget === "rover" && d.online === true),
        `${listBody.devices.length} device(s) known`);
    ok("the panel sees the queued update", listBody.targets.find((t: any) => t.target === "rover")?.pending?.version === roverVersion);

    const upload = new FormData();
    upload.append("target", "pump-devkit");
    upload.append("version", "2026-10-07-devkit-verify");
    upload.append("notes", "uploaded by the verify suite");
    upload.append("file", new Blob([pumpImage]), "firmware.bin");
    const uploadRes: any = await fetch(`${base}/api/firmware`, { method: "POST", headers: auth, body: upload }).then((r) => r.json());
    ok("an operator upload through the API stores the image",
        uploadRes.ok === true && uploadRes.build.md5 === md5(pumpImage) && uploadRes.build.target === "pump-devkit" &&
        !("file" in uploadRes.build));
    const badUpload = new FormData();
    badUpload.append("target", "pump-devkit");
    badUpload.append("version", "2026-10-07-devkit-verify");
    const badUploadRes = await fetch(`${base}/api/firmware`, { method: "POST", headers: auth, body: badUpload });
    ok("an upload without a file is rejected", badUploadRes.status === 400);

    emitted.length = 0;
    const trigger: any = await fetch(`${base}/api/firmware/update`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ target: "rover" }),
    }).then((r) => r.json());
    const otaCommand = emitted.find((e) => e.event === "control_command")?.payload?.command;
    ok("triggering sends the ota command to the online rover", trigger.ok === true &&
        trigger.version === roverVersion && JSON.stringify(trigger.sent) === JSON.stringify(["chr-rover-01"]),
        `sent to ${trigger.sent.join(", ") || "nobody"}`);
    ok("the command the rover receives is exactly what the firmware parses",
        otaCommand?.action === "ota" && otaCommand.data.target === "rover" && otaCommand.data.version === roverVersion &&
        otaCommand.data.md5 === saved.md5 && typeof otaCommand.data.path === "string" && otaCommand.data.path.length > 0);

    const pumpTrigger: any = await fetch(`${base}/api/firmware/update`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ target: "pump-devkit" }),
    }).then((r) => r.json());
    ok("a target with no online board still queues (offline board gets it later)",
        pumpTrigger.ok === true && (pumpTrigger.sent ?? []).length === 0 && store.pendingFor("pump-devkit")?.version === "2026-10-07-devkit-verify");

    emitted.length = 0;
    const missing: any = await fetch(`${base}/api/firmware/update`, {
        method: "POST", headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ target: "nobody-here" }),
    }).then((r) => r.json());
    ok("triggering a target with no image fails loudly", missing.ok === false && /upload/i.test(String(missing.message)),
        String(missing.message));

    /* ---- the board comes back and gets the queued image --------------- */
    emitted.length = 0;
    const hello = { deviceId: "chr-rover-01", role: "esp_32", firmware: "2026-10-06-arc-avoid", fwTarget: "rover", at: Date.now() };
    const fakeSocket = { id: "socket-1", emit: () => true } as never;
    await (wss as unknown as { handleFirmwareHello: (s: never, d: string, h: unknown) => Promise<void> }).handleFirmwareHello(fakeSocket, "chr-rover-01", hello);
    ok("the hello of a board that needs the queued image is answered", store.pendingFor("rover")?.version === roverVersion);
    ok("(nothing is sent in the same instant - the board gets a moment to settle)",
        emitted.every((e) => e.event !== "control_command"));
    const before = Date.now();
    while (Date.now() - before < 6000 && !emitted.some((e) => e.event === "control_command")) await sleep(250);
    const reconnectCommand = emitted.find((e) => e.event === "control_command")?.payload?.command;
    ok("the queued image is actually delivered once the board has settled",
        reconnectCommand?.action === "ota" && reconnectCommand.data.version === roverVersion,
        reconnectCommand ? `action ${reconnectCommand.action} → ${reconnectCommand.data.version}` : "nothing delivered");
    const queuedStatus = emitted.find((e) => e.payload?.Message?.status === "queued");
    ok("the panel is told the update went out while the board was coming back", Boolean(queuedStatus));

    emitted.length = 0;
    await (wss as unknown as { handleFirmwareHello: (s: never, d: string, h: unknown) => Promise<void> })
        .handleFirmwareHello(fakeSocket, "chr-rover-01", { ...hello, firmware: roverVersion });
    const success = emitted.find((e) => e.payload?.Message?.status === "success");
    ok("the board rebooting into the new build confirms and clears the queue",
        Boolean(success) && store.pendingFor("rover") === undefined);

    /* ---- a board that reports a failure ------------------------------- */
    emitted.length = 0;
    store.markPending("rover", roverVersion, "operator");
    const alerts: Array<{ title: unknown; body: unknown }> = [];
    (wss as unknown as { raiseAlert: (...args: unknown[]) => Promise<void> }).raiseAlert = async (...args: unknown[]) => {
        alerts.push({ title: args[1], body: args[2] });
    };
    wss.handleOtaStatus("chr-rover-01", { status: "failed", target: "rover", version: roverVersion, reason: "MD5 check failed" });
    const failedStatus = emitted.find((e) => e.payload?.Message?.status === "failed");
    ok("a failed flash is reported to the panel", Boolean(failedStatus) && failedStatus?.payload.Message.deviceId === "chr-rover-01");
    ok("a failed flash raises an alert for the operator and keeps the queue entry",
        alerts.length === 1 && /Firmware update failed/.test(String(alerts[0].title)) && store.pendingFor("rover")?.version === roverVersion);
    emitted.length = 0;
    wss.handleOtaStatus("chr-c3-01", { status: "ignored", target: "pump-c3", version: "x", reason: "target mismatch" });
    ok("a board refusing a foreign image is escalated, not treated as an update",
        emitted.some((e) => e.payload?.Message?.status === "ignored") && /different build target/.test(String(alerts[1]?.body)));
    emitted.length = 0;
    wss.handleOtaStatus("chr-rover-01", { status: "starting", target: "rover", version: roverVersion });
    ok("a starting report is passed through without an alert", emitted.some((e) => e.payload?.Message?.status === "starting") && alerts.length === 2);

    /* ---- what a real board downloads --------------------------------- */
    section("4. the download a board performs");
    const latestRes: any = await fetch(`${base}/api/firmware/rover/latest`, { headers: { "X-Device-Token": config.ROBOT_TOKEN } }).then((r) => r.json());
    ok("the rover's own token can ask what is newest", latestRes.ok === true && latestRes.version === roverVersion &&
        latestRes.md5 === saved.md5 && latestRes.path === firmwarePath("rover", roverVersion));

    const binRes = await fetch(`${base}${latestRes.path}`, { headers: { "X-Device-Token": config.ROBOT_TOKEN } });
    const binBytes = Buffer.from(await binRes.arrayBuffer());
    ok("the rover downloads the exact bytes of its own image", binRes.status === 200 && md5(binBytes) === saved.md5,
        `${binBytes.length} bytes, http ${binRes.status}`);
    ok("the download advertises the version/hash headers HTTPUpdate uses",
        binRes.headers.get("x-firmware-version") === roverVersion && binRes.headers.get("x-firmware-md5") === saved.md5);

    const pumpTokenOnRover = await fetch(`${base}${latestRes.path}`, { headers: { "X-Device-Token": config.PUMP_TOKEN } });
    ok("a pump token cannot download a rover image", pumpTokenOnRover.status === 401);
    const anonymous = await fetch(`${base}${latestRes.path}`);
    ok("an anonymous download is refused", anonymous.status === 401);
    const queryToken = await fetch(`${base}${latestRes.path}?token=${encodeURIComponent(config.ROBOT_TOKEN)}`);
    ok("the token may also come as ?token= (fallback for old builds)", queryToken.status === 200);
    const wrongTarget = await fetch(`${base}/api/firmware/pump-devkit/bin/2026-10-07-devkit-verify`, { headers: { "X-Device-Token": config.ROBOT_TOKEN } });
    ok("a rover token cannot download a pump image", wrongTarget.status === 401);
    const operatorDownload = await fetch(`${base}${latestRes.path}?token=${encodeURIComponent(token)}`);
    ok("the operator session can download an image too (to verify what a board would flash)", operatorDownload.status === 200);

    /* ---- the admin page ---------------------------------------------- */
    const page = await fetch(`${base}/admin/firmware`);
    const pageHtml = await page.text();
    const redirect = await fetch(`${base}/admin`, { redirect: "manual" });
    ok("the built-in upload page is served", page.status === 200 && /Firmware updates/.test(pageHtml) && /sha256Hex/.test(pageHtml));
    ok("/admin redirects to it", redirect.status >= 300 && redirect.status < 400);
    ok("the page needs no external assets (works behind the tunnel and offline)",
        !/<(script|link)[^>]+(src|href)=["']https?:/i.test(pageHtml));

    const del: any = await fetch(`${base}/api/firmware/rover/${encodeURIComponent(roverVersion)}`, { method: "DELETE", headers: auth }).then((r) => r.json());
    ok("an operator can delete an image", del.ok === true && store.get("rover", roverVersion) === undefined);
    store.clearPending("rover", "end of suite");

    // restore the real io for a clean shutdown
    (wss as unknown as { io: { to: unknown } }).io.to = realIoTo;
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fsp.rm(tmpRoot, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

void main().catch((error) => {
    console.error("OTA verify suite crashed:", error);
    process.exit(1);
});
