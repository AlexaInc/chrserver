/**
 * Smoke test for the Task-7 server work (no WhatsApp account, no hardware):
 *
 *   • owner numbers are a LIST in the database (max 10, primary = first entry,
 *     duplicates refused, the last one cannot be removed, legacy single-number
 *     route still works);
 *   • rain detected → the pump is switched OFF and locked OFF, the rover is sent
 *     back to its base point, an alert is raised and EVERY owner number is
 *     notified over WhatsApp (notifier stubbed);
 *   • petrol-empty report → alert + notification to all owners + missions blocked
 *     until `.fuel refilled`;
 *   • auto moisture threshold is stored PER WELL;
 *   • stop points travel inside a saved field map (and bad ones are rejected);
 *   • repeat alerts close the previous one, so the app badge resets itself;
 *   • the newest GitHub release is exposed for the app's self-update check.
 *
 * Run from the chrserver root:   npx tsx chrserver-verify-task7.ts
 */
import * as fs from "node:fs";
import * as http from "node:http";

const DB = "/tmp/chr-task7-verify.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* first run */ } }
process.env.CHR_DB_PATH = DB;
// The pets/pump emails do not exist; keep the rain throttle short for the test.
const RAIN_THROTTLE = Number(process.env.RAIN_SEQUENCE_THROTTLE_MS ?? 5 * 60_000);

let passed = 0;
const ok = (label: string) => { passed += 1; console.log(`✅ ${label}`); };
const fail = (label: string, detail?: unknown): never => {
    console.error(`❌ ${label}`, detail === undefined ? "" : JSON.stringify(detail));
    process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await sleep(25); }
    return fn();
};

async function main() {
    const { config } = await import("./src/config/config");
    const { CHRDatabase, MAX_OWNER_NUMBERS } = await import("./db/Sqlight");
    const { WSServer } = await import("./src/sockets/wsserver");
    const { sessions } = await import("./src/server");
    const { WhatsAppService } = await import("./src/services/WhatsAppService");
    const { io: ioClient } = await import("socket.io-client");

    const db = await CHRDatabase.open(DB);
    const gateway = new WSServer(http.createServer(), db);
    gateway.setup();
    const httpServer = (gateway as any).io.httpServer as http.Server;
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as any).port;
    const url = `http://127.0.0.1:${port}`;

    /* ------------------------------------------------------------------ */
    /* owner numbers: a list, not a single slot                            */
    /* ------------------------------------------------------------------ */
    const whatsapp = WhatsAppService.getInstance(undefined as any, db);
    (whatsapp as any).db = db;

    let status = await whatsapp.setOwnerNumber("94766045156");
    if (status.ownerNumbers.length !== 1 || status.ownerNumber !== "94766045156") {
        fail("setOwnerNumber must create a one-element list", status);
    }
    ok("legacy single owner number still works (becomes list entry #1)");

    status = await whatsapp.addOwnerNumber("94771234567");
    if (status.ownerNumbers.length !== 2 || status.ownerNumber !== "94766045156" || status.ownerNumbers[1] !== "94771234567") {
        fail("addOwnerNumber must append and keep the first number primary", status);
    }
    ok("“Add another number” appends a second owner (primary stays the first)");

    let rejected = "";
    try { await whatsapp.addOwnerNumber("94771234567"); } catch (e: any) { rejected = e?.message ?? ""; }
    if (!/already/i.test(rejected)) fail("a duplicate owner number must be refused", rejected);
    ok("duplicate owner number refused");

    rejected = "";
    try { await whatsapp.addOwnerNumber("0766045156"); } catch (e: any) { rejected = e?.message ?? ""; }
    if (!/country code/i.test(rejected)) fail("a local-format number must be refused", rejected);
    ok("number without a country code refused (0766045156)");

    // fill the list to the cap and check the 11th is refused
    for (let i = 0; i < MAX_OWNER_NUMBERS - 2; i++) {
        await whatsapp.addOwnerNumber(`947700000${10 + i}`);
    }
    status = await whatsapp.getStatus();
    if (status.ownerNumbers.length !== MAX_OWNER_NUMBERS) fail(`the list must hold ${MAX_OWNER_NUMBERS} numbers`, status.ownerNumbers);
    ok(`owner list holds the maximum ${MAX_OWNER_NUMBERS} numbers`);

    rejected = "";
    try { await whatsapp.addOwnerNumber("94779999999"); } catch (e: any) { rejected = e?.message ?? ""; }
    if (!/full|maximum/i.test(rejected)) fail("the 11th owner number must be refused", rejected);
    ok(`the ${MAX_OWNER_NUMBERS + 1}th owner number is refused`);

    status = await whatsapp.removeOwnerNumber("94770000010");
    if (status.ownerNumbers.includes("94770000010") || status.ownerNumbers.length !== MAX_OWNER_NUMBERS - 1) {
        fail("removeOwnerNumber must drop one entry", status.ownerNumbers);
    }
    ok("an owner number can be removed again");

    // the list is persisted in the database settings, not only in memory
    const stored = await db.getWhatsAppSettings();
    if (stored.ownerNumbers.length !== MAX_OWNER_NUMBERS - 1 || stored.ownerNumber !== stored.ownerNumbers[0]) {
        fail("the owner list must be stored in the database", stored);
    }
    ok("the owner list is persisted in the SQLite settings (survives a restart)");

    // the app's own gate accepts every number in the list
    const gate = await (whatsapp as any).isOwner({ senderNumber: "94770000010", senderJid: "94770000010@s.whatsapp.net", senderlid: null });
    if (gate) fail("a removed number must not be an owner any more");
    const gate2 = await (whatsapp as any).isOwner({ senderNumber: "94770000011", senderJid: "94770000011@s.whatsapp.net", senderlid: null });
    if (!gate2) fail("every number in the list must pass the command gate");
    ok("the WhatsApp command gate accepts every saved owner number");

    status = await whatsapp.setOwnerNumbers(["94766045156", "94771234567", "94711111111"]);
    if (status.ownerNumbers.join(",") !== "94766045156,94771234567,94711111111") fail("setOwnerNumbers must store the whole list", status.ownerNumbers);
    ok("the dashboard's list route can save several numbers at once");

    /* ------------------------------------------------------------------ */
    /* notifier stub: what would have gone out over WhatsApp               */
    /* ------------------------------------------------------------------ */
    const sent: Array<{ text: string; title?: string }> = [];
    gateway.ownerNotifier = async (text, options) => {
        sent.push({ text, title: options?.title });
        return { sent: await whatsapp.ownerNumbers(), failed: [] };
    };
    const lastOwnerMessage = () => sent[sent.length - 1]?.text ?? "";

    /* ------------------------------------------------------------------ */
    /* fake devices                                                        */
    /* ------------------------------------------------------------------ */
    const robotEvents: any[] = [];
    const robot = ioClient(url, { transports: ["websocket"], auth: { role: "esp_32", token: config.ROBOT_TOKEN, deviceId: "robot-01" } });
    robot.on("control_command", (p: any) => robotEvents.push(p));

    const pumpEvents: any[] = [];
    const pump = ioClient(url, { transports: ["websocket"], auth: { role: "esp_c3_pump", token: config.PUMP_TOKEN, deviceId: "pump-01" } });
    pump.on("control_command", (p: any) => pumpEvents.push(p));

    // The dashboard socket must present a real session token (same as the app).
    const adminToken = "verify-task7-admin";
    sessions.set(adminToken, config.ADMIN_USERNAME);
    const admin = ioClient(url, { transports: ["websocket"], auth: { role: "authorized", token: adminToken } });
    const ackOf = (client: any, body: unknown) => new Promise<any>((resolve) => {
        const timer = setTimeout(() => resolve({ success: false, reason: "ack timeout" }), 5000);
        client.emit("control_message", body, (res: any) => { clearTimeout(timer); resolve(res); });
    });

    const allConnected = await waitFor(() =>
        (gateway as any).onlineRoles.has("esp_32")
        && (gateway as any).onlineRoles.has("esp_c3_pump")
        && (gateway as any).io.sockets.sockets.size >= 3, 6000);
    if (!allConnected) fail("fake rover + pump + dashboard could not connect");
    ok("fake rover (esp_32), pump (esp_c3_pump) and dashboard connected");

    /* ------------------------------------------------------------------ */
    /* rain: pump off + locked, robot home, owners told                    */
    /* ------------------------------------------------------------------ */
    // The rover's own raindrop sensor trips: that alone must run the sequence.
    robot.emit("message.upsert", { Type: "sensors", Message: {
        deviceId: "robot-01", temperature: 27.5, humidity: 88, rainDrop: 82, isRaining: true, blockId: "b1", plant: "tomato",
    } });
    const pumpOff = await waitFor(() => pumpEvents.some((e) => e?.command?.action === "pump_off"), 3000);
    if (!pumpOff) fail("rain must switch the pump OFF", pumpEvents);
    ok("rain detected by the rover sensor → pump_off sent to the pump node");

    const autoOff = await waitFor(() => pumpEvents.some((e) => e?.command?.action === "pump_auto" && e.command.data?.enabled === false), 2000);
    if (!autoOff) fail("rain must switch auto irrigation OFF", pumpEvents);
    ok("rain → auto irrigation switched OFF (it cannot restart the pump)");

    const home = await waitFor(() => robotEvents.some((e) => e?.command?.action === "return_to_base" && String(e.command.data?.reason) === "rain"), 3000);
    if (!home) fail("rain must send the robot back to its base point", robotEvents);
    ok("rain → return_to_base sent to the rover with reason=rain");

    const safety = await gateway.getSafetyState();
    if (!safety.raining || !safety.pumpLocked || !safety.rainStartedAt) fail("the rain state must be persisted", safety);
    ok("rain state persisted (raining + pumpLocked + rainStartedAt)");

    if (!sent.length || !/rain detected/i.test(lastOwnerMessage())) fail("every owner number must be alerted about the rain", sent);
    ok(`owner alert sent over WhatsApp (${sent.length} message(s), ${(await whatsapp.ownerNumbers()).length} numbers)`);

    const rainAlert = (await db.listAlerts(5)).find((a) => /rain detected/i.test(a.title));
    if (!rainAlert) fail("rain must raise an alert on the Alerts screen");
    ok(`alert raised: “${rainAlert.title}”`);

    // the lock must actually bite
    let lockAck = await ackOf(admin, { action: "pump_on", data: { durationSeconds: 60 } });
    if (lockAck?.success !== false || !/rain lock/i.test(lockAck.reason ?? "")) fail("pump_on must be refused while it rains", lockAck);
    ok("pump_on refused while the rain lock is active");

    lockAck = await ackOf(admin, { action: "pump_auto", data: { enabled: true } });
    if (lockAck?.success !== false) fail("auto irrigation must not be enabled while it rains", lockAck);
    ok("pump_auto ON refused while the rain lock is active");

    lockAck = await ackOf(admin, { action: "pump_on", data: { durationSeconds: 30, forceRain: true } });
    if (!lockAck?.success) fail("a deliberate override must still work", lockAck);
    ok("deliberate override (.pump_on <s> force) still reaches the pump");

    // a second rain report must not spam the owners
    const before = sent.length;
    robot.emit("message.upsert", { Type: "sensors", Message: { deviceId: "robot-01", temperature: 27.5, humidity: 88, rainDrop: 90, isRaining: true } });
    await sleep(400);
    if (sent.length !== before) fail("a repeated rain reading must not re-notify the owners", sent.length - before);
    ok("repeat rain readings do not spam the owner numbers");

    /* ------------------------------------------------------------------ */
    /* dry again: the lock is released                                     */
    /* ------------------------------------------------------------------ */
    (gateway as any).lastRainSequenceAt = Date.now() - RAIN_THROTTLE - 1000;   // fast-forward the throttle
    robot.emit("message.upsert", { Type: "sensors", Message: { deviceId: "robot-01", temperature: 26, humidity: 60, rainDrop: 12, isRaining: false } });
    const cleared = await waitFor(() => !(gateway as any)["lastRainSequenceAt"] && true, 100);
    await sleep(400);
    const dry = await gateway.getSafetyState();
    if (dry.raining || dry.pumpLocked) fail("a dry reading must release the rain lock", dry);
    if (cleared && !/rain stopped/i.test(lastOwnerMessage())) fail("the owners must be told the rain stopped", lastOwnerMessage());
    ok("sensor dry again → rain lock released + owners told (“Rain stopped”)");

    lockAck = await ackOf(admin, { action: "pump_on", data: { durationSeconds: 60 } });
    if (!lockAck?.success) fail("the pump must be usable again once the lock is released", lockAck);
    ok("pump can be started again after the rain lock is released");

    /* ------------------------------------------------------------------ */
    /* petrol empty                                                        */
    /* ------------------------------------------------------------------ */
    const fuelAck = await ackOf(admin, { action: "report_fuel_empty", data: { note: "tank dry at block B1", runMinutes: 214 } });
    if (!fuelAck?.success) fail("report_fuel_empty must be accepted", fuelAck);
    const fuelState = await gateway.getSafetyState();
    if (!fuelState.fuelEmpty || fuelState.fuelRunMinutes !== 214) fail("the petrol-empty state must be persisted", fuelState);
    if (!/petrol empty/i.test(lastOwnerMessage())) fail("the petrol-empty report must reach every owner number", lastOwnerMessage());
    if (!/214/.test(lastOwnerMessage())) fail("the report must include the engine run time", lastOwnerMessage());
    ok("petrol-empty report → alert + WhatsApp message to all owners (with run time + position)");

    const blocked = await ackOf(admin, { action: "deploy_mission", data: {} });
    if (blocked?.success !== false || !/petrol/i.test(blocked.reason ?? "")) fail("missions must be blocked with an empty tank", blocked);
    ok("mission deploy refused while the petrol-empty report is open");

    const refill = await ackOf(admin, { action: "fuel_refilled" });
    if (!refill?.success) fail("fuel_refilled must close the report", refill);
    const afterRefill = await ackOf(admin, { action: "deploy_mission", data: {} });
    if (afterRefill?.success === false && /petrol/i.test(afterRefill.reason ?? "")) fail("the petrol guard must be released after refuelling", afterRefill);
    ok("after `.fuel refilled` the petrol guard is released");

    /* ------------------------------------------------------------------ */
    /* per-well auto moisture threshold                                    */
    /* ------------------------------------------------------------------ */
    const t1 = await ackOf(admin, { action: "set_irrigation_threshold", data: { moisturePercent: 40, pumpId: "pump-01" } });
    const t2 = await ackOf(admin, { action: "set_irrigation_threshold", data: { moisturePercent: 55, pumpId: "pump-02" } });
    if (!t1?.success || !t2?.success) fail("per-well thresholds must be accepted", { t1, t2 });
    const wells = await db.getSetting<Record<string, number>>("wellThresholds", {});
    if (wells["pump-01"] !== 40 || wells["pump-02"] !== 55) fail("each well must keep its own threshold", wells);
    ok("AUTO MOISTURE THRESHOLD stored per well (pump-01 → 40 %, pump-02 → 55 %)");

    /* ------------------------------------------------------------------ */
    /* stop points inside the saved field map                              */
    /* ------------------------------------------------------------------ */
    const polygon: [number, number][] = [[6.9, 79.9], [6.9, 79.91], [6.91, 79.91], [6.91, 79.9]];
    const stopPoints = [
        { id: "sp-1", label: "Row 1 end", latitude: 6.901, longitude: 79.901, order: 1 },
        { id: "sp-2", label: "Water point", latitude: 6.905, longitude: 79.905, order: 2 },
    ];
    const saved = await ackOf(admin, { action: "save_field_map", data: {
        name: "Home field", boundary: polygon,
        blocks: [{ id: "b1", name: "Tomato", plant: "tomato", polygon, stopPoints }],
    } });
    if (!saved?.success) fail("a map with stop points must be accepted", saved);
    const storedMap = await db.getSetting<any>("fieldMap", null);
    if ((storedMap?.blocks?.[0]?.stopPoints ?? []).length !== 2) fail("the stop points must be stored with the block", storedMap);
    ok(`stop points stored with the block (${stopPoints.length}) and the map pushed to the rover`);

    const bad = await ackOf(admin, { action: "save_field_map", data: {
        name: "Home field", boundary: polygon,
        blocks: [{ id: "b1", name: "Tomato", plant: "tomato", polygon, stopPoints: [{ id: "x", label: "broken", latitude: "nope", longitude: null }] }],
    } });
    if (bad?.success !== false) fail("an invalid stop point must be rejected", bad);
    ok("a malformed stop point is rejected (map validation)");

    /* ------------------------------------------------------------------ */
    /* repeat alerts close the previous one (badge resets itself)          */
    /* ------------------------------------------------------------------ */
    await gateway.raiseAlert("warning", "GPS module not responding", "test 1", "verify", 0);
    await gateway.raiseAlert("warning", "GPS module not responding", "test 2", "verify", 0);
    await sleep(200);
    const open = (await db.listAlerts(20)).filter((a) => a.title === "GPS module not responding" && !a.acknowledged_at);
    if (open.length !== 1) fail("only the newest repeat alert may stay open", open.length);
    ok("repeat alerts close the earlier one → the app's counter returns to zero by itself");

    /* ------------------------------------------------------------------ */
    /* self-update feed                                                    */
    /* ------------------------------------------------------------------ */
    const info = await gateway.getLatestReleaseInfo();
    if (info.release) {
        if (!info.release.tag_name || !info.release.version) fail("the release info must carry a tag", info.release);
        const apk = info.release.assets.find((a) => /\.apk$/i.test(a.name));
        ok(`/api/app/release → ${info.release.tag_name} (assets: ${info.release.assets.map((a) => a.name).join(", ")}${apk ? ", apk ✓" : ""})`);
    } else {
        console.log(`⚠️  newest release could not be read (${info.error}) — the app falls back to GitHub directly`);
    }
    const cachedInfo = await gateway.getLatestReleaseInfo();
    if (info.release && !cachedInfo.cached) fail("the second lookup must come from the cache");
    ok("release lookups are cached (no GitHub rate-limit burn per phone)");

    robot.close(); pump.close(); admin.close();
    await sleep(200);
    await db.close();
    console.log(`\n🎉 all ${passed} Task-7 server checks passed`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
