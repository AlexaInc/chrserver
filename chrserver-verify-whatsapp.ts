/**
 * Throwaway smoke test for the new WhatsApp service surface.
 * Boots ONLY the Express app (no AI models, no socket gateway, no WhatsApp
 * connection) against a temporary SQLite file and exercises:
 *   - WhatsApp settings persistence (owner number with country code)
 *   - the /api/whatsapp* endpoints and their validation
 *   - number normalisation rules
 * Run: npx tsx tmp-verify-wa.ts
 */
import * as fs from "node:fs";

const DB = "/tmp/wa-verify.db";
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* first run */ } }
process.env.CHR_DB_PATH = DB;

async function main() {
    const { Server, sessions } = await import("./src/server");
    const { config } = await import("./src/config/config");
    const { CHRDatabase } = await import("./db/Sqlight");
    const { WhatsAppService, normalizeWhatsAppNumber, jidToNumber, numberToJid, WA_FOOTER } = await import("./src/services/WhatsAppService");

    /* ---------- pure helpers ---------- */
    const norm: Array<[string, string | null]> = [
        ["0766045156", null],                    // local format → rejected (no country code)
        ["+94 76 604 5156", "94766045156"],
        ["0094-766-045-156", "94766045156"],
        ["94766045156", "94766045156"],
        ["12345", null],                          // too short
        ["", null],
    ];
    for (const [input, expected] of norm) {
        const got = normalizeWhatsAppNumber(input);
        if (got !== expected) throw new Error(`normalizeWhatsAppNumber(${JSON.stringify(input)}) = ${got}, expected ${expected}`);
    }
    if (jidToNumber("94766045156:12@lid") !== "94766045156") throw new Error("jidToNumber failed");
    if (numberToJid("94766045156") !== "94766045156@s.whatsapp.net") throw new Error("numberToJid failed");
    console.log("✅ number helpers");

    /* ---------- database ---------- */
    const db = await CHRDatabase.open(DB);
    const wa = WhatsAppService.getInstance(undefined as any, db);
    let status = await wa.getStatus();
    if (status.state !== "idle" || status.enabled !== false || status.ownerNumber !== null) throw new Error(`unexpected initial status ${JSON.stringify(status)}`);
    const saved = await db.saveWhatsAppSettings({ ownerNumber: "94702267847", enabled: true, linkedNumber: "94702267847" });
    status = await wa.getStatus();
    if (status.ownerNumber !== "94702267847" || status.enabled !== true || status.sessionExists !== false) throw new Error(`settings not persisted: ${JSON.stringify(status)}`);
    const reread = await db.getWhatsAppSettings();
    if (reread.ownerLids.length !== 0 || reread.linkedNumber !== saved.linkedNumber) throw new Error("settings round-trip failed");
    await db.saveWhatsAppSettings({ enabled: false, linkedNumber: null, ownerNumber: null });
    console.log("✅ db persistence (owner number + link state)");

    /* ---------- REST endpoints ---------- */
    const server = new Server({ port: 0, domain: "127.0.0.1" });
    server.configureMiddleware();
    server.setupRoutes({ models: [], db });
    server.configureErrorHandling();
    const httpServer = server.app.listen(0, "127.0.0.1");
    await new Promise((r) => httpServer.once("listening", r));
    const port = (httpServer.address() as any).port;
    const base = `http://127.0.0.1:${port}`;
    const token = "verify-token";
    sessions.set(token, config.ADMIN_USERNAME);
    const call = async (method: string, path: string, body?: unknown) => {
        const res = await fetch(`${base}${path}`, {
            method,
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { code: res.status, json: (await res.json()) as any };
    };

    let r = await call("GET", "/api/whatsapp");
    if (r.code !== 200 || r.json.state !== "idle" || r.json.sessionExists !== false) throw new Error(`GET /api/whatsapp → ${JSON.stringify(r)}`);
    console.log("✅ GET /api/whatsapp →", r.json.state, "sessionExists:", r.json.sessionExists);

    r = await call("POST", "/api/whatsapp/owner", { number: "0766045156" });
    if (r.code !== 400) throw new Error(`local-format owner should be rejected, got ${r.code}`);
    console.log("✅ POST /api/whatsapp/owner rejects a number without country code");

    r = await call("POST", "/api/whatsapp/owner", { number: "+94 76 604 5156" });
    if (r.code !== 200 || r.json.ownerNumber !== "94766045156") throw new Error(`owner save failed: ${JSON.stringify(r)}`);
    console.log("✅ POST /api/whatsapp/owner →", r.json.ownerNumber);

    r = await call("POST", "/api/whatsapp/link", { number: "0766045156" });
    if (r.code !== 400) throw new Error(`link should validate before pairing, got ${r.code}`);
    console.log("✅ POST /api/whatsapp/link validates the number before pairing");

    r = await call("POST", "/api/whatsapp/test");
    if (r.code !== 500 || !/not connected/i.test(r.json.message ?? "")) throw new Error(`test message should fail while unlinked: ${JSON.stringify(r)}`);
    console.log("✅ POST /api/whatsapp/test fails cleanly while unlinked");

    r = await call("POST", "/api/whatsapp/unlink");
    if (r.code !== 200 || r.json.enabled !== false || r.json.linkedNumber !== null || r.json.ownerNumber !== "94766045156") {
        throw new Error(`unlink should keep the owner number and clear the link: ${JSON.stringify(r)}`);
    }
    console.log("✅ POST /api/whatsapp/unlink → keeps owner", r.json.ownerNumber, "| cleared link");


    /* ---------- bot logic with a fake socket (no network) ---------- */
    const { splitCommandTokens } = await import("./src/services/WhatsAppService");

    const tokenCases: Array<[string | null, string, string, string]> = [
        ["pump_on", "60", "pump", "on 60"],
        ["pump", "on 60", "pump", "on 60"],
        ["mission_deploy", "all", "mission", "deploy all"],
        ["mission", "deploy block-1", "mission", "deploy block-1"],
        ["status", "", "status", ""],
        ["tlm", "", "tlm", ""],
    ];
    for (const [cmd, rest, head, args] of tokenCases) {
        const got = splitCommandTokens(cmd, rest);
        if (got.head !== head || got.args !== args) throw new Error(`splitCommandTokens(${cmd}, ${rest}) = ${JSON.stringify(got)}`);
    }
    console.log("✅ command tokenising (.pump_on 60 == .pump on 60)");

    // NOTE: extractButtonReply receives the *content* of the matched message key
    // (msgType === "buttonsResponseMessage" → content is the inner object), which
    // is exactly how parseMessage calls it.
    const replyCases: Array<[any, string]> = [
        [{ selectedButtonId: ".status" }, ".status"],
        [{ singleSelectReply: { selectedRowId: ".pump_off" } }, ".pump_off"],
        [{ selectedId: ".mission_status" }, ".mission_status"],
        [{ nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: ".menu", display_text: "Menu" }) } }, ".menu"],
        [{ conversation: "no button here" }, null as any],
    ];
    for (const [content, expected] of replyCases) {
        const got = WhatsAppService.extractButtonReply(content);
        if (got.id !== (expected as any)) throw new Error(`extractButtonReply(${JSON.stringify(content)}) = ${got.id}`);
    }
    console.log("✅ all four button-reply shapes are normalised to commands");

    const sent: Array<{ jid: string; content: any }> = [];
    (wa as any).WaSocket = {
        user: { id: "94766045156:1@s.whatsapp.net" },
        sendMessage: async (jid: string, content: any) => { sent.push({ jid, content }); return { key: { id: "mid" } }; },
    };
    const last = () => sent[sent.length - 1];
    const bodyOf = (content: any): string => String(content.text ?? content.caption ?? "");
    const dm = (from: string, content: any, alt?: string) => ({
        key: { remoteJid: `${from}@s.whatsapp.net`, remoteJidAlt: alt, fromMe: false, id: `M${sent.length}` },
        message: content,
    });
    const ownerPhone = "94766045156";
    const stranger = "94702267847";

    await db.saveWhatsAppSettings({ ownerNumber: ownerPhone, linkedNumber: ownerPhone, enabled: true, ownerLids: [] });

    // plain typed command from a stranger → bilingual restriction wall with cta buttons
    sent.length = 0;
    await (wa as any).onMessage(dm(stranger, { conversation: ".status" }));
    if (sent.length !== 1) throw new Error(`stranger message should get exactly 1 reply, got ${sent.length}`);
    const wall = last().content;
    if (!/ACCESS RESTRICTION/.test(bodyOf(wall))) throw new Error("restriction text missing");
    if (wall.interactiveButtons?.length !== 2 || wall.interactiveButtons.some((b: any) => b.name !== "cta_url")) throw new Error("restriction buttons wrong");
    if (wall.footer !== "Powered by hazu@AlexaInc.github.io") throw new Error("restriction footer wrong");
    console.log("✅ non-owner is blocked with the contact wall + footer");

    // plain typed command from the owner → status card (no robot socket yet, still answered)
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".status" }));
    if (sent.length !== 1 || !/Robot/.test(bodyOf(last().content))) throw new Error(`owner .status not answered: ${JSON.stringify(sent)}`);
    if (last().content.footer !== "Powered by hazu@AlexaInc.github.io") throw new Error("status footer wrong");
    // Buttons are state-driven now: with no gateway/robot/pump online the card must
    // offer status-style actions only — never a hardcoded pump on/off pair.
    const earlyIds = (last().content.interactiveButtons ?? []).map((b: any) => JSON.parse(b.buttonParamsJson).id);
    if (!earlyIds.length || earlyIds.some((id: string) => id === ".pump_on 60" || id === ".pump_off" || id === ".mission_pause")) {
        throw new Error(`status card buttons are not state-driven: ${JSON.stringify(earlyIds)}`);
    }
    console.log("✅ owner typed .status → interactive status card");

    // quick-reply tap (id has no prefix) from an @lid-only chat → learned LID keeps working
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: ".menu" }) } } }, `${ownerPhone}@lid`));
    if (!/CONTROL MENU/.test(bodyOf(last().content))) throw new Error(`button reply .menu not handled: ${JSON.stringify(sent)}`);
    const learned = await db.getWhatsAppSettings();
    if (learned.ownerLids.length !== 1) throw new Error(`owner LID was not learned: ${JSON.stringify(learned.ownerLids)}`);
    sent.length = 0;
    await (wa as any).onMessage({
        key: { remoteJid: `${ownerPhone}@lid`, fromMe: false, id: "M-lid-only" },
        message: { conversation: ".pump_status" },
    });
    if (!/Pump status|No pump reading/.test(bodyOf(last().content))) throw new Error("lid-only owner message was not accepted");
    console.log("✅ LID-only owner chat still passes the gate (learned LID)");

    // pump commands reach the WSServer entry point (which is not running here)
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".pump_off" }));
    if (!/gateway is not ready/.test(bodyOf(last().content))) throw new Error(`pump command path broken: ${bodyOf(last().content)}`);
    if (last().content.footer !== WA_FOOTER) throw new Error(`pump reply lost the footer field: ${JSON.stringify(last().content)}`);
    console.log("✅ .pump_off routed through WSServer.controlPump (graceful when the gateway is down)");

    // noise: plain chatter, groups and our own messages are ignored
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: "hello robot" }));
    await (wa as any).onMessage({ key: { remoteJid: "12345@g.us", fromMe: false, id: "M3" }, message: { conversation: ".status" }, participant: `${ownerPhone}@s.whatsapp.net` });
    await (wa as any).onMessage({ key: { remoteJid: `${ownerPhone}@s.whatsapp.net`, fromMe: true, id: "M4" }, message: { conversation: ".status" } });
    if (sent.length !== 0) throw new Error(`ignored messages produced ${sent.length} replies`);
    console.log("✅ plain chatter, groups and self-messages stay silent");

    // every single outgoing message must carry the footer
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".blah" }));
    const missingFooter = sent.filter((m) => m.content.footer !== WA_FOOTER && !bodyOf(m.content).includes(WA_FOOTER));
    if (missingFooter.length) throw new Error(`${missingFooter.length} message(s) missing the footer`);
    console.log("✅ footer present on every outgoing message (" + sent.length + " checked)");

    /* ---------- state-driven buttons (never a fixed on/off, start/stop pair) ---------- */
    const { pumpButtons, missionButtons } = await import("./src/services/WhatsAppService");
    const eq = (label: string, got: string[], expected: string[]) => {
        if (got.join(",") !== expected.join(",")) throw new Error(`${label}: got [${got}] expected [${expected}]`);
    };
    eq("pump offline", pumpButtons({ pumpOnline: false }).map((b) => b.id), [".pump_status"]);
    eq("pump running", pumpButtons({ pumpOnline: true, pumpOn: true, autoMode: false }).map((b) => b.id), [".pump_off", ".pump_status"]);
    eq("pump idle manual", pumpButtons({ pumpOnline: true, pumpOn: false, autoMode: false }).map((b) => b.id), [".pump_on 60", ".pump_auto on"]);
    eq("pump idle auto", pumpButtons({ pumpOnline: true, pumpOn: false, autoMode: true }).map((b) => b.id), [".pump_on 60", ".pump_auto off"]);
    eq("robot offline", missionButtons({ robotOnline: false, hasMission: true }).map((b) => b.id), [".status"]);
    eq("patrolling", missionButtons({ robotOnline: true, state: "patrolling", hasMission: true }).map((b) => b.id), [".mission_pause", ".stop"]);
    eq("paused mission", missionButtons({ robotOnline: true, state: "idle", hasMission: true }).map((b) => b.id), [".mission_resume", ".stop"]);
    eq("no mission", missionButtons({ robotOnline: true, state: "idle", hasMission: false }).map((b) => b.id), [".mission", ".mission_status"]);
    eq("fault", missionButtons({ robotOnline: true, state: "fault", hasMission: true }).map((b) => b.id), [".stop", ".mission_status"]);
    console.log("✅ pump/mission button builders follow the live state");

    // Real gateway object so robot/pump online state is controllable here.
    const http = await import("node:http");
    const { WSServer } = await import("./src/sockets/wsserver");
    const gateway = new WSServer(http.createServer(), db);
    const online = (role: string, on: boolean) => {
        const roles = (gateway as any).onlineRoles as Set<string>;
        if (on) roles.add(role); else roles.delete(role);
    };
    const ids = (message: { content: any }): string[] =>
        (message.content.interactiveButtons ?? []).map((b: any) => JSON.parse(b.buttonParamsJson).id);
    const assertButtons = (round: string, must: string[], mustNot: string[]) => {
        const got = ids(last());
        for (const id of must) if (!got.includes(id)) throw new Error(`${round}: expected button ${id} in [${got}]`);
        for (const id of mustNot) if (got.includes(id)) throw new Error(`${round}: button ${id} must NOT be offered (state says otherwise)`);
        return got;
    };
    const missionRow = { missionId: "smoke-1", patrolId: 1, blocks: ["b1"], config: {}, waypoints: [], createdAt: Date.now() };

    // (a) robot patrolling + pump running → status card: Pump OFF + Pause, never the reverse
    online("esp_32", true); online("esp_c3_pump", true);
    await db.setSetting("activeMission", missionRow);
    (gateway as any).lastMission = { missionId: "smoke-1", state: "running", currentWaypoint: 1, totalWaypoints: 4, progress: 0.25 };
    await db.saveIrrigationReading({ deviceId: "pump-01", pumpOn: true, autoMode: false, soilMoisture: 22, threshold: 35 });
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".status" }));
    const patrolling = assertButtons("patrolling status card", [".pump_off", ".mission_pause"], [".pump_on 60", ".mission_resume"]);
    console.log("✅ patrolling + pumping → [", patrolling.join(" | "), "]");

    // (b) mission paused (idle) + pump off in auto mode → resume + pump ON + auto OFF
    (gateway as any).lastMission = { missionId: "smoke-1", state: "paused", currentWaypoint: 1, totalWaypoints: 4, progress: 0.25 };
    await db.saveIrrigationReading({ deviceId: "pump-01", pumpOn: false, autoMode: true, soilMoisture: 26, threshold: 35 });
    await db.setSetting("fieldMap", {
        name: "Smoke field",
        boundary: [[6.9, 79.9], [6.9, 79.91], [6.91, 79.91], [6.91, 79.9]],
        blocks: [{ id: "b1", name: "Tomato bed", plant: "tomato", polygon: [[6.9, 79.9], [6.9, 79.91], [6.91, 79.91], [6.91, 79.9]] }],
    });
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".pump" }));
    const pumpCard = assertButtons("pump card", [".pump_on 60", ".pump_auto off"], [".pump_off"]);
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".mission" }));
    // a paused mission legitimately offers Resume + Stop; it must not offer Pause
    // (nothing is driving) and the mission card is mission-focused, not pump-focused
    const missionCard = assertButtons("mission card", [".mission_resume", ".stop"], [".mission_pause", ".pump_on 60"]);
    const blockPicker = (last().content.interactiveButtons ?? []).find((b: any) => b.name === "single_select");
    if (!blockPicker || !JSON.stringify(blockPicker).includes(".mission_deploy b1")) throw new Error("mission card lost the block picker");
    console.log("✅ paused mission + auto-pump-off → pump card [", pumpCard.join(" | "), "] mission card [", missionCard.join(" | "), "] + block picker b1");

    // (c) robot offline → no start/stop/pause button anywhere, only status
    online("esp_32", false);
    (gateway as any).lastMission = {};
    await db.setSetting("activeMission", null);
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".status" }));
    const offlineRow = assertButtons("offline status card", [".status"], [".mission_pause", ".mission_resume", ".mission", ".stop"]);
    console.log("✅ robot offline → [", offlineRow.join(" | "), "] (no start/stop)");

    // (d) footer is a real footer everywhere, never glued into the body
    const glued = sent.filter((m) => bodyOf(m.content).includes(WA_FOOTER));
    const footless = sent.filter((m) => m.content.footer !== WA_FOOTER);
    if (glued.length || footless.length) throw new Error(`footer problem — glued: ${glued.length}, missing footer field: ${footless.length}`);
    console.log("✅ footer is a native footer field on every card (never inside the text)");

    /* ---------- bot ON/OFF switch ---------- */
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".bot" }));
    assertButtons(".bot card", [".bot off"], [".bot on"]);
    sent.length = 0;
    await (wa as any).onMessage(dm(ownerPhone, { conversation: ".bot off" }));
    if (!/bot OFF/i.test(bodyOf(last().content))) throw new Error(`.bot off confirmation missing: ${bodyOf(last().content)}`);
    await new Promise((r) => setTimeout(r, 1300));                 // the switch itself lands after the reply is delivered
    let afterOff = await db.getWhatsAppSettings();
    let offStatus = await wa.getStatus();
    if (afterOff.enabled !== false || offStatus.state !== "disabled" || offStatus.sessionHealth !== "not_linked") {
        throw new Error(`.bot off did not switch the service off: ${JSON.stringify({ enabled: afterOff.enabled, state: offStatus.state, health: offStatus.sessionHealth })}`);
    }
    console.log("✅ .bot off → replied first, then switched OFF (session kept, health => not_linked)");

    const onStatus = await wa.setEnabled(true);
    if (!onStatus.enabled || onStatus.state !== "idle") throw new Error(`setEnabled(true) without a session should stay idle: ${JSON.stringify(onStatus)}`);
    console.log("✅ switch ON without a session → stays idle (asks the app to link first)");

    /* ---------- session health verdicts ---------- */
    (wa as any).lastError = "Session logged out; link the account again";
    const invalid = await wa.getStatus();
    if (invalid.sessionHealth !== "invalid") throw new Error(`expected invalid, got ${invalid.sessionHealth}`);
    (wa as any).lastError = null;
    fs.mkdirSync("wasession", { recursive: true });
    fs.writeFileSync("wasession/creds.json", "{}");
    const inactive = await wa.getStatus();
    if (!inactive.sessionExists || inactive.sessionHealth !== "inactive") throw new Error(`expected inactive, got ${JSON.stringify({ exists: inactive.sessionExists, health: inactive.sessionHealth })}`);
    fs.rmSync("wasession", { recursive: true, force: true });
    console.log("✅ session health: invalid (logged out) · inactive (saved but off) · not_linked");

    (wa as any).WaSocket = undefined;

    r = await call("GET", "/api/whatsapp");
    if (!r.json.sessionHealth) throw new Error(`GET /api/whatsapp must expose sessionHealth: ${JSON.stringify(r.json)}`);
    r = await call("POST", "/api/whatsapp/enabled", { enabled: false });
    if (r.code !== 200 || r.json.enabled !== false || r.json.state !== "disabled") throw new Error(`/api/whatsapp/enabled OFF → ${JSON.stringify(r)}`);
    r = await call("POST", "/api/whatsapp/enabled", { enabled: true });
    if (r.code !== 200 || r.json.enabled !== true) throw new Error(`/api/whatsapp/enabled ON → ${JSON.stringify(r)}`);
    console.log("✅ POST /api/whatsapp/enabled toggles the bot (and sessionHealth is exposed)");

    await new Promise((resolve) => httpServer.close(resolve));
    await db.close();
    console.log("\n🎉 all WhatsApp API checks passed");
}

main().catch((error) => {
    console.error("❌ verify failed:", error);
    process.exit(1);
});
