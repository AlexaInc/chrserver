/**
 * Smoke test for the robot safety / field-map-cache work (no WhatsApp, no
 * hardware needed). Boots the real socket gateway against a temporary SQLite
 * file and talks to it with two fake clients: a rover (role esp_32) and an
 * authorized dashboard (role authorized).
 *
 * Run from the chrserver root:   npx tsx chrserver-verify-safety.ts
 */
import * as fs from "node:fs";
import * as http from "node:http";

const DB = "/tmp/chr-safety-verify.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* first run */ } }
process.env.CHR_DB_PATH = DB;

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
    const { CHRDatabase } = await import("./db/Sqlight");
    const { WSServer, mapRevision, clampPercent, clampAngle, DEFAULT_FLEET_CONFIG, MAP_HELLO_GRACE_MS } = await import("./src/sockets/wsserver");
    const { sessions } = await import("./src/server");
    const { io: ioClient } = await import("socket.io-client");

    const db = await CHRDatabase.open(DB);
    const gateway = new WSServer(http.createServer(), db);
    gateway.setup();
    const httpServer = (gateway as any).io.httpServer as http.Server;
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as any).port;
    const url = `http://127.0.0.1:${port}`;

    /* ------------------------------------------------ map revision hashing -- */
    const polygon: [number, number][] = [[6.9, 79.9], [6.9, 79.91], [6.91, 79.91], [6.91, 79.9]];
    const mapA = { name: "Home field", boundary: polygon, blocks: [{ id: "b1", name: "Tomato", plant: "tomato", polygon }] };
    const mapAReordered = { blocks: [{ plant: "tomato", polygon, name: "Tomato", id: "b1" }], boundary: polygon, name: "Home field" };
    const mapB = { ...mapA, name: "Home field (edited)" };

    const revA = mapRevision(mapA as any);
    if (revA !== mapRevision(mapAReordered as any)) fail("mapRevision must ignore key order", { revA, other: mapRevision(mapAReordered as any) });
    ok(`mapRevision is stable across key order (${revA})`);
    if (revA === mapRevision(mapB as any)) fail("mapRevision must change when the map changes");
    ok("mapRevision changes when the map content changes");

    await db.setSetting("fieldMap", { ...mapA, rev: revA });
    const entry = await gateway.getFieldMapWithRev();
    if (!entry || entry.rev !== revA) fail("stored map must expose its revision", entry);
    ok("stored field map exposes its revision (backfilled if missing)");

    /* --------------------------------------------------- rover connections -- */
    const robotEvents: any[] = [];
    const robot = ioClient(url, { transports: ["websocket"], auth: { role: "esp_32", token: config.ROBOT_TOKEN, deviceId: "robot-01" } });
    robot.on("control_command", (payload: any) => robotEvents.push(payload));
    const robotConnected = await waitFor(() => (gateway as any).onlineRoles.has("esp_32"), 4000);
    if (!robotConnected) fail("fake rover could not connect to the gateway");
    ok("fake rover connected (role esp_32, token auth)");

    // (a) The old firmware behaviour was: field_map pushed immediately on connect.
    await sleep(MAP_HELLO_GRACE_MS - 900);
    const earlyMap = robotEvents.filter((e) => e?.command?.action === "field_map");
    if (earlyMap.length) fail("field_map must not be pushed before the handshake", earlyMap[0]);
    ok(`field_map not sent during the ${MAP_HELLO_GRACE_MS} ms hello grace window`);

    // (b) Speed limits are pushed on connect so a wiped SD card still obeys the panel.
    const connectMotion = robotEvents.find((e) => e?.command?.action === "motion_config");
    if (!connectMotion) fail("connect must push the operator's speed limits", robotEvents);
    if (connectMotion.command.data.driveSpeedPercent !== DEFAULT_FLEET_CONFIG.driveSpeedPercent
        || connectMotion.command.data.turnSpeedPercent !== DEFAULT_FLEET_CONFIG.turnSpeedPercent) {
        fail("connect motion_config carries the fleet defaults", connectMotion.command.data);
    }
    if (connectMotion.command.data.sensorAngleLeftDeg !== DEFAULT_FLEET_CONFIG.sensorAngleLeftDeg
        || connectMotion.command.data.sensorAngleRightDeg !== DEFAULT_FLEET_CONFIG.sensorAngleRightDeg
        || connectMotion.command.data.avoidAssist !== DEFAULT_FLEET_CONFIG.avoidAssist) {
        fail("connect motion_config must carry the front-arc geometry", connectMotion.command.data);
    }
    ok(`connect pushes the speed limits (${connectMotion.command.data.driveSpeedPercent}/${connectMotion.command.data.turnSpeedPercent} %) and the front-arc angles (±${connectMotion.command.data.sensorAngleLeftDeg}°/±${connectMotion.command.data.sensorAngleRightDeg}°, assist ${connectMotion.command.data.avoidAssist})`);

    // The default bracket angles must be the printed mounts, not 0 (a 0° "side"
    // sensor points straight ahead and would leave the corners blind).
    if (DEFAULT_FLEET_CONFIG.sensorAngleLeftDeg < 20 || DEFAULT_FLEET_CONFIG.sensorAngleRightDeg < 20) {
        fail("side-sensor defaults must be splayed outwards", DEFAULT_FLEET_CONFIG);
    }
    ok("default arc geometry splays the side beams outwards (no corner blind spot by default)");

    // (c) device_hello with the CURRENT revision ⇒ the map must never be sent.
    const hello = { deviceId: "robot-01", role: "esp_32", firmware: "verify", mapRev: revA, mapBlocks: 1, mapBytes: 512, sd: true, driveSpeedPercent: 70, turnSpeedPercent: 65 };
    robot.emit("device_hello", hello);
    await sleep(1200);
    if (robotEvents.some((e) => e?.command?.action === "field_map")) fail("a rover holding the current map must not receive field_map");
    ok("device_hello with the current revision → field map NOT re-sent");

    await sleep(MAP_HELLO_GRACE_MS); // the grace timer must have been cancelled
    if (robotEvents.some((e) => e?.command?.action === "field_map")) fail("grace timer was not cancelled by device_hello");
    ok("the grace-window timer is cancelled by the handshake");

    const sync = await gateway.fieldMapSyncStatus();
    if (!sync.inSync || sync.robotRev !== revA || sync.serverRev !== revA || sync.sd !== true) fail("fieldMapSyncStatus must report in-sync", sync);
    ok(`fieldMapSyncStatus → inSync=${sync.inSync} rev=${sync.rev ?? sync.serverRev}`);

    // (d) A stale revision ⇒ the map IS sent, carrying the new revision.
    robotEvents.length = 0;
    robot.emit("device_hello", { ...hello, mapRev: "deadbeefcafe" });
    const gotMap = await waitFor(() => robotEvents.some((e) => e?.command?.action === "field_map"), 2500);
    if (!gotMap) fail("a stale revision must trigger the field_map download", robotEvents);
    const sentMap = robotEvents.find((e) => e?.command?.action === "field_map").command.data;
    if (sentMap.rev !== revA) fail("the sent map must carry the server revision", sentMap.rev);
    if (!Array.isArray(sentMap.blocks) || sentMap.blocks.length !== 1) fail("the sent map must carry the blocks", sentMap.blocks);
    ok(`stale revision (deadbeefcafe) → field map re-sent with rev ${sentMap.rev}`);
    if ((await gateway.fieldMapSyncStatus()).inSync) fail("status must not claim in-sync while the rover has an unknown revision");
    ok("status reports NOT in sync until the rover confirms");

    // (e) The rover confirms what it stored on SD (map_status).
    robot.emit("message.upsert", { Type: "map_status", Message: { deviceId: "robot-01", reason: "saved", rev: revA, name: mapA.name, blocks: 1, bytes: 512, sd: true, path: "/chrhw/fieldmap.json" } });
    await sleep(250);
    const statusAfter = await gateway.computeStatus();
    if (!statusAfter.fieldMap?.inSync) fail("map_status must mark the cache in sync", statusAfter.fieldMap);
    ok("map_status from SD → inSync true, reason saved");

    // (f) Old firmware that never announces a revision still gets the map.
    const legacyEvents: any[] = [];
    const legacy = ioClient(url, { transports: ["websocket"], auth: { role: "esp_32", token: config.ROBOT_TOKEN, deviceId: "robot-legacy" } });
    legacy.on("control_command", (payload: any) => legacyEvents.push(payload));
    const legacyGotMap = await waitFor(() => legacyEvents.some((e) => e?.command?.action === "field_map"), MAP_HELLO_GRACE_MS + 2000);
    if (!legacyGotMap) fail("legacy firmware must still receive the map after the grace window", legacyEvents);
    ok("firmware without a hello still receives the map (legacy path)");
    legacy.close();
    await sleep(200);

    /* ------------------------------------------- motion/safety telemetry --- */
    robot.emit("message.upsert", { Type: "motion_config", Message: {
        deviceId: "robot-01", reason: "applied", driveSpeedPercent: 70, turnSpeedPercent: 65,
        drivePwm: 77, turnPwm: 62, appliedPwm: 44, cruiseBasePwm: 110, turnBasePwm: 95,
        hardMaxPwm: 150, intent: "FORWARD", source: "manual", obstacleStopCm: 30, driveFailsafeMs: 1500,
    } });
    await sleep(150);
    let status = await gateway.computeStatus();
    if (status.motion?.drivePwm !== 77 || status.motion?.appliedPwm !== 44 || status.motion?.hardMaxPwm !== 150) {
        fail("computeStatus must surface the rover's real PWM values", status.motion);
    }
    ok(`status.motion → drive ${status.motion.drivePwm} PWM, now ${status.motion.appliedPwm} PWM, ceiling ${status.motion.hardMaxPwm} PWM`);

    const alerts: string[] = [];
    const originalRaise = (gateway as any).raiseAlert.bind(gateway);
    (gateway as any).raiseAlert = async (...args: any[]) => { alerts.push(String(args[1])); return originalRaise(...args); };

    robot.emit("message.upsert", { Type: "motion_config", Message: { deviceId: "robot-01", reason: "obstacle", intent: "FORWARD", obstacleStopCm: 30, driveSpeedPercent: 70, turnSpeedPercent: 65 } });
    await sleep(150);
    status = await gateway.computeStatus();
    if (status.motion?.blockedBy !== "obstacle") fail("an obstacle stop must be reported", status.motion);
    if (!alerts.some((t) => /obstacle/i.test(t))) fail("an obstacle stop must raise an alert", alerts);
    ok("obstacle stop → status.blockedBy=obstacle + info alert");

    robot.emit("message.upsert", { Type: "motion_config", Message: { deviceId: "robot-01", reason: "failsafe", intent: "STOP", driveSpeedPercent: 70, turnSpeedPercent: 65 } });
    await sleep(150);
    if (!alerts.some((t) => /failsafe/i.test(t))) fail("a failsafe cut must raise an alert", alerts);
    status = await gateway.computeStatus();
    if (status.motion?.blockedBy !== "failsafe" || status.motion?.intent !== "STOP") fail("a failsafe cut must be reported", status.motion);
    ok("dead-man failsafe → blockedBy=failsafe, intent STOP + warning alert");
    (gateway as any).raiseAlert = originalRaise;

    /* --------------------------------------- front-arc planner (avoidance) -- */
    const arcAlerts: string[] = [];
    const raiseOrig = (gateway as any).raiseAlert.bind(gateway);
    (gateway as any).raiseAlert = async (...args: any[]) => { arcAlerts.push(String(args[1])); return raiseOrig(...args); };

    // (a) Going AROUND a plant: the rover reports the manoeuvre, not a stop.
    robot.emit("message.upsert", { Type: "motion_config", Message: {
        deviceId: "robot-01", reason: "avoiding", blockedBy: "plant-left",
        driveSpeedPercent: 70, turnSpeedPercent: 65, intent: "FORWARD", source: "manual",
        avoidState: "steer-right", avoidDir: 1, gapLeftCm: 20, gapRightCm: 48, frontCm: 26,
        sensorAngleLeftDeg: 45, sensorAngleRightDeg: 45, avoidAssist: true,
        obstacleStopCm: 30, emergencyStopCm: 12,
    } });
    await sleep(150);
    status = await gateway.computeStatus();
    const m = status.motion;
    if (m?.avoidState !== "steer-right" || m?.avoidDir !== 1 || m?.blockedBy !== "plant-left") {
        fail("the arc manoeuvre must reach the dashboard verbatim", m);
    }
    if (m?.gapLeftCm !== 20 || m?.gapRightCm !== 48 || m?.frontCm !== 26) fail("gap/front distances must be surfaced", m);
    if (m?.sensorAngleLeftDeg !== 45 || m?.sensorAngleRightDeg !== 45 || m?.avoidAssist !== true) {
        fail("the arc geometry the rover uses must be surfaced", m);
    }
    if (!arcAlerts.some((t) => /steering around a plant/i.test(t))) fail("going around a plant must raise the info alert", arcAlerts);
    if (arcAlerts.some((t) => /no way past/i.test(t))) fail("avoiding must NOT be reported as stuck", arcAlerts);
    ok(`avoiding (steer-right, gaps 20/48 cm, blockedBy plant-left) → status + info alert, not a stop`);

    // (b) Creeping past at crawl speed is its own state (still not a stop).
    robot.emit("message.upsert", { Type: "motion_config", Message: {
        deviceId: "robot-01", reason: "creep", blockedBy: "plant-left", intent: "FORWARD",
        driveSpeedPercent: 70, turnSpeedPercent: 65, avoidState: "creep", avoidDir: 1, gapLeftCm: 22, gapRightCm: 44, frontCm: 19,
    } });
    await sleep(150);
    status = await gateway.computeStatus();
    if (status.motion?.avoidState !== "creep") fail("creep must be surfaced", status.motion);
    if (!arcAlerts.some((t) => /creeping past/i.test(t))) fail("creeping past must raise the info alert", arcAlerts);
    ok("creep past a plant (crawl speed) → status.avoidState=creep + info alert");

    // (c) The ONE planned stop: no side gap is wide enough -> warning, honestly labelled.
    robot.emit("message.upsert", { Type: "motion_config", Message: {
        deviceId: "robot-01", reason: "no-path", blockedBy: "no-path", intent: "STOP",
        driveSpeedPercent: 70, turnSpeedPercent: 65, avoidState: "no-path", avoidDir: 0, gapLeftCm: 9, gapRightCm: 11, frontCm: 24,
    } });
    await sleep(150);
    status = await gateway.computeStatus();
    if (status.motion?.blockedBy !== "no-path" || status.motion?.avoidState !== "no-path") fail("no-path must be surfaced", status.motion);
    if (!arcAlerts.some((t) => /no way past/i.test(t))) fail("a no-path stop must raise the warning", arcAlerts);
    ok("no-path (gaps 9/11 cm) → blockedBy=no-path + warning alert");

    // (d) Emergency ring: the only unconditional brake.
    robot.emit("message.upsert", { Type: "motion_config", Message: {
        deviceId: "robot-01", reason: "emergency", blockedBy: "emergency", intent: "STOP",
        driveSpeedPercent: 70, turnSpeedPercent: 65, avoidState: "emergency", emergencyStopCm: 12, frontCm: 10,
    } });
    await sleep(150);
    status = await gateway.computeStatus();
    if (status.motion?.blockedBy !== "emergency") fail("an emergency brake must be surfaced", status.motion);
    if (!arcAlerts.some((t) => /emergency stop/i.test(t))) fail("the emergency ring must raise a warning", arcAlerts);
    ok("emergency ring → blockedBy=emergency + warning alert");
    (gateway as any).raiseAlert = raiseOrig;

    // (e) Angle clamping: the panel can never point a side beam past 80°.
    if (clampAngle(undefined, 45) !== 45 || clampAngle(-10, 45) !== 0 || clampAngle(120, 45) !== 80 || clampAngle(52.6, 45) !== 53) {
        fail("clampAngle is broken");
    }
    ok("clampAngle(undefined/-10/120/52.6) → 45/0/80/53");

    /* ------------------------------------------------- dashboard commands -- */
    const ackOf = (client: any, body: unknown) => new Promise<any>((resolve) => {
        client.emit("control_message", body, (res: any) => resolve(res));
    });
    const adminToken = "verify-admin-token";
    sessions.set(adminToken, config.ADMIN_USERNAME);
    const admin = ioClient(url, { transports: ["websocket"], auth: { role: "authorized", token: adminToken } });
    await waitFor(() => (gateway as any).io.sockets.sockets.size >= 3, 4000);

    robotEvents.length = 0;
    let ack = await ackOf(admin, { action: "set_speed", data: { percent: 45 } });
    if (!ack?.success) fail("set_speed must be accepted (it used to be in UNSUPPORTED_ACTIONS)", ack);
    const motionCmd = await waitFor(() => robotEvents.some((e) => e?.command?.action === "motion_config"), 1500);
    if (!motionCmd) fail("set_speed must reach the rover", robotEvents);
    const applied = robotEvents.find((e) => e?.command?.action === "motion_config").command.data;
    if (applied.driveSpeedPercent !== 45 || applied.turnSpeedPercent !== 45) fail("set_speed {percent} must set both limits", applied);
    ok(`set_speed 45 % forwarded to the rover → ${applied.driveSpeedPercent}/${applied.turnSpeedPercent} %`);

    ack = await ackOf(admin, { action: "set_speed", data: { percent: 1000 } });
    if (!ack?.data || ack.data.driveSpeedPercent !== 100) fail("set_speed must clamp to 100", ack);
    ok("set_speed clamps an absurd value to 100 % (the firmware ceiling still applies)");

    robotEvents.length = 0;
    ack = await ackOf(admin, { action: "apply_config", data: { rowSpacingM: 1.2, scanSpacingM: 0.8, arrivalRadiusM: 2, irrigationThresholdPercent: 35, diseaseAlertThreshold: 0.6, driveSpeedPercent: 55, turnSpeedPercent: 50, sensorAngleLeftDeg: 120, sensorAngleRightDeg: 35.4, avoidAssist: false } });
    const fleet = await gateway.getFleetConfig();
    if (!ack?.success || fleet.driveSpeedPercent !== 55 || fleet.turnSpeedPercent !== 50) fail("apply_config must store the speed limits", { ack, fleet });
    if (fleet.rowSpacingM !== 1.2) fail("apply_config must keep storing the patrol geometry", fleet);
    if (fleet.sensorAngleLeftDeg !== 80 || fleet.sensorAngleRightDeg !== 35 || fleet.avoidAssist !== false) {
        fail("apply_config must store + clamp the front-arc geometry", fleet);
    }
    const arcPush = await waitFor(() => robotEvents.some((e) => e?.command?.action === "motion_config"), 1500);
    if (!arcPush) fail("apply_config must push the new arc geometry to the rover", robotEvents);
    const arcPushed = robotEvents.find((e) => e?.command?.action === "motion_config").command.data;
    if (arcPushed.sensorAngleLeftDeg !== 80 || arcPushed.avoidAssist !== false) fail("the pushed motion_config must carry the clamped geometry", arcPushed);
    ok(`apply_config → drive ${fleet.driveSpeedPercent} % / turn ${fleet.turnSpeedPercent} % + arc ±${fleet.sensorAngleLeftDeg}°/±${fleet.sensorAngleRightDeg}°, assist ${fleet.avoidAssist} (120° clamped to 80° and pushed)`);

    robotEvents.length = 0;
    ack = await ackOf(admin, { action: "get_motion_status" });
    if (!ack?.success) fail("get_motion_status must be an accepted rover action", ack);
    const pulled = await waitFor(() => robotEvents.some((e) => e?.command?.action === "get_motion_status"), 1200);
    if (!pulled) fail("get_motion_status must be forwarded to the rover", robotEvents);
    ok("get_motion_status is forwarded to the rover (pull form)");

    // Offline robot: the limit is still stored, the operator is told why it did not apply.
    (gateway as any).onlineRoles.delete("esp_32");
    robotEvents.length = 0;
    ack = await ackOf(admin, { action: "set_speed", data: { percent: 40 } });
    if (ack?.success !== false || !/offline/i.test(ack.reason ?? "")) fail("set_speed must report an offline robot", ack);
    if (robotEvents.some((e) => e?.command?.action === "motion_config")) fail("nothing may be emitted to an offline robot");
    const offlineStatus = await gateway.computeStatus();
    if (offlineStatus.state !== "offline" || !offlineStatus.motion || !offlineStatus.fieldMap) {
        fail("status must keep reporting motion + map state while offline", offlineStatus);
    }
    ok("offline set_speed → stored + honest reason, and status still carries motion + fieldMap");
    (gateway as any).onlineRoles.add("esp_32");

    // Saving a NEW map recomputes the revision and force-sends it.
    robotEvents.length = 0;
    ack = await ackOf(admin, { action: "save_field_map", data: mapB });
    if (!ack?.success || !ack.data?.rev || ack.data.rev === revA) fail("save_field_map must return a new revision", ack);
    const forced = await waitFor(() => robotEvents.some((e) => e?.command?.action === "field_map"), 1500);
    if (!forced) fail("a new map must be pushed to the rover", robotEvents);
    const forcedMap = robotEvents.find((e) => e?.command?.action === "field_map").command.data;
    if (forcedMap.rev !== ack.data.rev || forcedMap.name !== mapB.name) fail("the pushed map must be the edited one", forcedMap);
    ok(`save_field_map → rev ${ack.data.rev} pushed immediately (edited name included)`);

    const finalSync = await gateway.fieldMapSyncStatus();
    if (finalSync.inSync) fail("a freshly edited map cannot be in sync before the rover confirms", finalSync);
    ok("edited map ⇒ NOT in sync until the rover reports the new revision");

    // Percent clamping helper used by every entry point.
    if (clampPercent(undefined, 70) !== 70 || clampPercent(-5, 70) !== 0 || clampPercent(999, 70) !== 100) fail("clampPercent is broken");
    ok("clampPercent(undefined/-5/999) → 70/0/100");

    robot.close(); admin.close();
    await new Promise<void>((r) => httpServer.close(() => r()));
    console.log(`\n🎉 all ${passed} safety/map checks passed`);
    process.exit(0);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
