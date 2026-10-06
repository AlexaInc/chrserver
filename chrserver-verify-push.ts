/**
 * chrserver — push notification checks.
 *
 * Runs the REAL PushService against a REAL (local) HTTP "Expo" endpoint, then
 * checks the parts that are easy to get wrong in production:
 *
 *   • token validation (a junk token never reaches the network)
 *   • the same phone registering twice does not duplicate, and the device list
 *     is capped, oldest-first
 *   • severity floor: info alerts do not buzz the phone, critical ones do, with
 *     the `safety` channel and `max` priority
 *   • alert → push wiring: rail safety alerts reach every phone
 *   • a ticket answer of `DeviceNotRegistered` retires that token (an
 *     uninstalled app is not pushed to for ever) while the others still deliver
 *   • a 500 is retried and then succeeds; a 4xx is not retried at all
 *   • PUSH_ENABLED=false means Expo is never called
 *   • the /api/push endpoints (register / status / test / unregister) over HTTP
 *
 * Run:  npx tsx chrserver-verify-push.ts
 */
import http from "node:http";
import {
    PushService,
    isValidPushToken,
    maskPushToken,
    channelFor,
    severityAtLeast,
    clipBody,
    MAX_NOTIFICATION_BODY,
    MAX_PUSH_DEVICES,
    PUSH_DEVICES_KEY,
} from "./src/services/PushService";

let passed = 0;
const failures: string[] = [];
const ok = (m: string) => { passed++; console.log(`✅ ${m}`); };
const fail = (m: string) => { failures.push(m); console.log(`❌ ${m}`); };
const check = (cond: boolean, m: string) => (cond ? ok(m) : fail(m));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 *  A tiny in-memory settings store, the same shape as the SQLite one
 * ------------------------------------------------------------------ */
class MemStore {
    private data = new Map<string, unknown>();
    public writes = 0;
    public async getSetting<T>(key: string, fallback: T): Promise<T> {
        return (this.data.has(key) ? (this.data.get(key) as T) : fallback);
    }
    public async setSetting<T>(key: string, value: T): Promise<void> {
        this.writes++;
        this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
    public raw<T>(key: string, fallback: T): T {
        return (this.data.get(key) as T) ?? fallback;
    }
}

/* ------------------------------------------------------------------ *
 *  A fake Expo push endpoint: records every request, answers the way Expo does
 * ------------------------------------------------------------------ */
interface Recorded {
    body: any;
    authorization?: string;
    at: number;
}
async function startFakeExpo(opts: {
    statuses?: Array<{ status: number; body?: any }>;
    ticket?: (message: any) => any;
} = {}) {
    const requests: Recorded[] = [];
    let call = 0;
    const server = http.createServer((req, res) => {
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
            let body: any = null;
            try { body = JSON.parse(raw); } catch { /* keep null */ }
            requests.push({ body, authorization: req.headers.authorization as string | undefined, at: Date.now() });
            const scripted = opts.statuses?.[call++];
            if (scripted && scripted.status >= 400) {
                res.writeHead(scripted.status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(scripted.body ?? { errors: [{ message: "scripted failure" }] }));
                return;
            }
            const list = Array.isArray(body) ? body : [body];
            const data = list.map((m) => opts.ticket?.(m) ?? { status: "ok", id: `ticket-${m?.to ?? "?"}` });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ data }));
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as any).port;
    return { url: `http://127.0.0.1:${port}/--/api/v2/push/send`, requests, close: () => server.close() };
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
const TOKEN_A = "ExponentPushToken[AAAAaaaa1111]";
const TOKEN_B = "ExponentPushToken[BBBBbbbb2222]";
const TOKEN_C = "ExponentPushToken[CCCCcccc3333]";

async function main() {
    /* ---------------- 1. token validation ---------------- */
    check(isValidPushToken(TOKEN_A) && isValidPushToken("ExpoPushToken[xyz-123]"), "Expo push tokens are recognised");
    check(
        !isValidPushToken("") && !isValidPushToken("fcm:abc") && !isValidPushToken("ExponentPushToken[]") && !isValidPushToken("ExponentPushToken[abc]def"),
        "junk tokens are rejected before anything is sent",
    );
    check(maskPushToken(TOKEN_A) === "AAAA…1111", `a token is masked when shown to the app (${maskPushToken(TOKEN_A)})`);

    /* ---------------- 2. severity + channel mapping ---------------- */
    check(channelFor("critical").channelId === "safety" && channelFor("critical").priority === "max",
        "a critical alert goes out on the SAFETY channel with max priority (wakes a sleeping phone)");
    check(channelFor("warning").priority === "high" && channelFor("info").priority === "default",
        "a warning is high priority, an info notification is not");
    check(severityAtLeast("critical", "warning") && !severityAtLeast("info", "warning"),
        "the severity floor keeps informational alerts off the lock screen");
    check(clipBody("x".repeat(500)).length === MAX_NOTIFICATION_BODY && clipBody("a  b\n\nc").includes("a b c"),
        `the body is clipped to ${MAX_NOTIFICATION_BODY} characters and whitespace is collapsed`);

    /* ---------------- 3. registration ---------------- */
    const expo = await startFakeExpo();
    const store = new MemStore();
    PushService.resetInstance();
    const push = PushService.getInstance({ store, url: expo.url, logger: noopLog, retryDelayMs: 10, minSeverity: "warning" });

    const bad = await push.registerDevice({ token: "nope", platform: "android" });
    check(!bad.ok && bad.error === "not-a-push-token" && expo.requests.length === 0,
        "registering a bad token is refused and nothing is sent anywhere");

    const first = await push.registerDevice({ token: TOKEN_A, platform: "android", label: "farm phone", userId: "demo" });
    check(first.ok && first.devices === 1, "a valid token is stored (device count 1)");
    await push.registerDevice({ token: TOKEN_A, platform: "android", label: "renamed" });
    const afterDup = await push.listDevices();
    check(afterDup.length === 1 && afterDup[0].label === "renamed",
        "the same phone registering again updates the record instead of duplicating it");
    check(String((store.raw(PUSH_DEVICES_KEY, []) as any[])[0]?.token) === TOKEN_A,
        "the devices live in the database (setting key pushDevices), so a restart keeps them");

    for (let i = 0; i < MAX_PUSH_DEVICES + 3; i++) {
        await push.registerDevice({ token: `ExponentPushToken[bulk${String(i).padStart(4, "0")}]`, platform: "ios" });
    }
    const capped = await push.listDevices();
    check(capped.length === MAX_PUSH_DEVICES,
        `the phone list is capped at ${MAX_PUSH_DEVICES} (oldest first, so the phones in use stay)`);
    await push.removeDevice(TOKEN_A);
    await push.registerDevice({ token: TOKEN_A, platform: "android", label: "farm phone" });

    /* ---------------- 4. alerts → push ---------------- */
    const info = await push.notifyAlert({ severity: "info", title: "Obstacle stop", description: "nothing in the way" });
    check(!info.ok && info.skipped === "below-warning" && expo.requests.length === 0,
        "an info alert is NOT pushed (operator asked for the safety ones, not chatter)");

    const crit = await push.notifyAlert({
        id: 7, severity: "critical", source: "safety",
        title: "Rain detected — pump off, robot returning to base",
        description: "Rain 82% on the roof sensor. Pump switched off and the rover is on its way back.",
    });
    check(crit.ok, "a critical alert is pushed to every registered phone");
    const batch = expo.requests.at(-1)!.body;
    const msg = Array.isArray(batch) ? batch[0] : batch;
    check(typeof msg.title === "string" && msg.title.includes("Rain detected"), "the notification carries the alert title");
    check(msg.channelId === "safety" && msg.priority === "max" && msg.body.length <= MAX_NOTIFICATION_BODY,
        "…on the safety channel, max priority, with a clipped body");
    check(msg.data?.type === "alert" && msg.data?.alertId === 7 && msg.data?.severity === "critical",
        "the payload tells the app it is an alert (so tapping it can open the right screen)");

    const warning = await push.notifyAlert({ severity: "warning", title: "GPS/field-map sync pending", description: "the rover has no fix" });
    check(warning.ok, "a warning is pushed too (default floor)");

    /* ---------------- 5. dead tokens ---------------- */
    await push.registerDevice({ token: TOKEN_B, platform: "android" });
    await push.registerDevice({ token: TOKEN_C, platform: "ios" });
    const expo2 = await startFakeExpo({
        ticket: (m) => (m.to === TOKEN_B
            ? { status: "error", message: "The device is not registered", details: { error: "DeviceNotRegistered" }, to: m.to }
            : { status: "ok", id: "ok" }),
    });
    PushService.resetInstance();
    const push2 = PushService.getInstance({ store, url: expo2.url, logger: noopLog, retryDelayMs: 10 });
    const beforeMixed = expo2.requests.length;
    const activeBefore = push2.activeDevices(await push2.listDevices()).length;
    const mixed = await push2.notifyAlert({ severity: "critical", title: "Petrol empty — rover cannot move", description: "report" });
    check(
        mixed.ok === false && mixed.sent === activeBefore - 1,
        `when one phone rejects the token, every other phone still gets the alert (${mixed.sent} of ${activeBefore})`,
    );
    const devices = await push2.listDevices();
    const retired = devices.find((d) => d.token === TOKEN_B);
    check(!!retired?.disabledReason && retired?.disabledReason === "DeviceNotRegistered",
        "an uninstalled app's token is retired with the reason kept (visible in /api/push)");
    check(push2.activeDevices(devices).length === devices.length - 1,
        "a retired token is not pushed to again");
    await push2.notifyAlert({ severity: "critical", title: "again", description: "and again" });
    check(
        expo2.requests.slice(beforeMixed + 1).every((r) => (Array.isArray(r.body) ? r.body : [r.body]).every((m: any) => m.to !== TOKEN_B)),
        "the retired token is gone from later batches too",
    );

    /* ---------------- 6. retries ---------------- */
    await expo2.close();
    const expo3 = await startFakeExpo({ statuses: [{ status: 500 }, { status: 200 }] });
    PushService.resetInstance();
    const push3 = PushService.getInstance({ store, url: expo3.url, logger: noopLog, retryDelayMs: 5 });
    const retried = await push3.notifyAlert({ severity: "warning", title: "Retry me", description: "first call fails" });
    check(retried.ok && expo3.requests.length === 2,
        "a 500 from the push gateway is retried and the alert still arrives");

    await expo3.close();
    const expo4 = await startFakeExpo({ statuses: [{ status: 400, body: { errors: [{ message: "bad request" }] } }] });
    PushService.resetInstance();
    const push4 = PushService.getInstance({ store, url: expo4.url, logger: noopLog, retryDelayMs: 5 });
    const rejected = await push4.notifyAlert({ severity: "warning", title: "Bad payload", description: "4xx" });
    check(!rejected.ok && expo4.requests.length === 1,
        "a 4xx is a bug on our side, not a flaky network: it is reported, not retried");

    await expo4.close();
    PushService.resetInstance();
    const down = PushService.getInstance({ store, url: "http://127.0.0.1:1/--/api/v2/push/send", logger: noopLog, retryDelayMs: 5, retries: 1 });
    const unreachable = await down.notifyAlert({ severity: "critical", title: "No network", description: "gateway down" });
    const st = await down.getStatus();
    check(!unreachable.ok && !!st.lastError && st.history.length > 0,
        "an unreachable gateway is reported in the status (lastError + history), never silently swallowed");

    /* ---------------- 7. switched off ---------------- */
    PushService.resetInstance();
    const disabled = PushService.getInstance({ store, url: "http://127.0.0.1:1/never-called", enabled: false, logger: noopLog });
    const off = await disabled.notifyAlert({ severity: "critical", title: "nope", description: "nope" });
    check(!off.ok && off.skipped === "disabled", "PUSH_ENABLED=false: alerts are not pushed at all");

    /* ---------------- 8. the test button + status ---------------- */
    PushService.resetInstance();
    const push5 = PushService.getInstance({ store, url: expo.url, logger: noopLog, retryDelayMs: 5 });
    const before = expo.requests.length;
    const test = await push5.sendTest("hello from Settings");
    check(test.ok && test.sent >= 1 && expo.requests.length === before + 1, "Settings' test notification sends one batch");
    check((expo.requests.at(-1)!.body as any[])[0]?.data?.type === "test", "the test notification is marked as a test");
    const status = await push5.getPublicStatus();
    check(status.enabled && status.activeDevices >= 2 && status.sent > 0 && status.lastAttempt?.ok === true,
        "GET /api/push statuses count the phones and the sends");
    check(status.deviceList.every((d) => !d.token.includes("ExponentPushToken")),
        "the app only ever sees masked tokens");
    check(typeof status.minSeverity === "string" && status.url.includes("/--/api/v2/push/send"),
        "the status reports the floor and the gateway it is using");

    /* ---------------- 9. no devices at all ---------------- */
    const emptyStore = new MemStore();
    PushService.resetInstance();
    const lonely = PushService.getInstance({ store: emptyStore, url: expo.url, logger: noopLog });
    const none = await lonely.notifyAlert({ severity: "critical", title: "nobody home", description: "no phones registered" });
    check(!none.ok && none.skipped === "no-devices", "with no registered phone the send is a no-op (no pointless HTTP call)");

    await expo.close();

    /* ---------------- 10. the HTTP endpoints ---------------- */
    await httpEndpoints();

    console.log("");
    if (failures.length) {
        console.log(`❌ ${passed} passed, ${failures.length} failed`);
        failures.forEach((f) => console.log(`   - ${f}`));
        process.exit(1);
    }
    console.log(`🎉 all ${passed} push checks passed`);
}

/**
 * The REST surface, over a real server instance: register → status → test →
 * unregister, with the auth middleware in the way.
 */
async function httpEndpoints() {
    process.env.PUSH_URL = "";                     // never let a real send happen
    process.env.PUSH_ENABLED = "true";
    const { Server } = await import("./src/server");
    const { CHRDatabase } = await import("./db/Sqlight");
    const dbFile = `push-verify-${Date.now()}.db`;
    const db = await CHRDatabase.open(dbFile);
    const server = new Server({ port: 0, domain: "127.0.0.1" });
    server.configureMiddleware();
    server.setupRoutes({ models: new Map(), db });
    server.configureErrorHandling();
    const httpServer = await new Promise<any>((resolve) => {
        const h = server.app.listen(0, "127.0.0.1", () => resolve(h));
    });
    const port = (httpServer.address() as any).port;

    PushService.resetInstance();
    const expo = await startFakeExpo();
    PushService.getInstance({ store: db, url: expo.url, logger: noopLog, retryDelayMs: 5 });

    // The HTTP middleware authenticates against the same `sessions` map the
    // socket layer uses, keyed by the ADMIN username constant — not the literal
    // string "admin" (that is why the first run of this suite got a 401).
    const token = "verify-push-" + Date.now();
    const { sessions } = await import("./src/server");
    const { config } = await import("./src/config/config");
    sessions.set(token, config.ADMIN_USERNAME);
    const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
    const post = async (path: string, body?: any) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const get = async (path: string) => {
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: auth });
        return { status: res.status, body: await res.json().catch(() => null) };
    };

    const unauth = await fetch(`http://127.0.0.1:${port}/api/push`);
    check(unauth.status === 401, "GET /api/push needs the client login (401 without a token)");

    const reg = await post("/api/push/register", { token: TOKEN_A, platform: "android", label: "verify phone" });
    check(reg.status === 200 && reg.body?.ok === true && reg.body?.devices >= 1, "POST /api/push/register stores the phone");

    const badReg = await post("/api/push/register", { token: "not-a-token" });
    check(badReg.status === 400 && badReg.body?.error === "not-a-push-token", "a bad token is a 400 with a clear reason");

    const status = await get("/api/push");
    check(status.status === 200 && status.body?.push?.activeDevices >= 1, "GET /api/push reports the phones");

    const test = await post("/api/push/test", { text: "hello" });
    check(test.status === 200 && test.body?.ok === true && test.body?.sent >= 1, "POST /api/push/test reaches the phones");

    const unreg = await post("/api/push/unregister", { token: TOKEN_A });
    check(unreg.status === 200 && unreg.body?.ok === true, "POST /api/push/unregister removes the phone");

    await sleep(30);
    await expo.close();
    httpServer.close();
    await (db as any).close?.();
    // The check database is a throwaway: remove it (and its WAL side files).
    for (const suffix of ["", "-wal", "-shm"]) {
        try { require("node:fs").rmSync(`${dbFile}${suffix}`, { force: true }); } catch { /* ignore */ }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
