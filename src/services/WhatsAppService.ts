/**
 * src/services/WhatsAppService.ts — chrserver WhatsApp control bot
 * ------------------------------------------------------------------
 * One WhatsApp account is paired to the server (pairing code, no QR scan
 * needed) and can then operate the farm from a chat:
 *
 *   • robot / mission commands   → .mission deploy, .mission_pause, .stop ...
 *   • water pump commands        → .pump_on 60, .pump_off, .pump_auto on ...
 *   • read-only farm data        → .status, .telemetry, .alerts, .reports
 *
 * Design rules (kept deliberately strict — this bot can move hardware):
 *  1. ONLY the owner number stored in the database may issue commands. The
 *     number is saved with its country code (E.164 digits, e.g. 94766045156)
 *     — see db/Sqlight.ts `WhatsAppSettings`, and it is edited from the
 *     client app's Settings screen (or `.owner set <number>` in chat).
 *  2. Every command goes through the SAME entry points the dashboard uses
 *     (WSServer.deployMission / setRobotMode / controlRobot / controlPump),
 *     so robot-online checks, mission planning limits and audit behaviour are
 *     identical no matter where the command came from.
 *  3. Every single outgoing message carries the footer
 *     "Powered by hazu@AlexaInc.github.io".
 *  4. Replies use interactive native-flow buttons: quick replies for the
 *     frequent actions (`.status`, `.pump_on`, `.pump_off`, ...) and a
 *     single_select list for the full command menu. Any reply id is a plain
 *     command, so the same parser handles typed text and button taps
 *     (see alexainc/alexa-v3 src/bot.js + alexainc/baileys-mod).
 *
 * Button payloads follow the shape @alexainc/baileys-mod understands
 * (lib/Utils/messages.js → `interactiveButtons` → nativeFlowMessage):
 *
 *   { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text, id }) }
 *   { name: "cta_url",     buttonParamsJson: JSON.stringify({ display_text, url, merchant_url }) }
 *   { name: "single_select", buttonParamsJson: JSON.stringify({ title, sections: [{ title, rows: [...] }] }) }
 *
 * Incoming replies arrive as one of:
 *   buttonsResponseMessage.selectedButtonId            (plain buttons)
 *   listResponseMessage.singleSelectReply.selectedRowId (single_select)
 *   templateButtonReplyMessage.selectedId               (template buttons)
 *   interactiveResponseMessage.nativeFlowResponseMessage.paramsJson → .id
 * and all four are normalised back to a command string by parseMessage().
 */

import {
    AuthenticationState,
    DisconnectReason,
    makeWASocket,
    proto,
    useMultiFileAuthState,
    WAMessage,
    WASocket,
} from '@alexainc/baileys-mod';
import { Logger, default as P } from "pino";
import { Boom } from '@hapi/boom';
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger as rootLogger } from "../logger";
import { CHRDatabase } from "../../db/Sqlight";
import { FieldMapMessage, WSServer } from "../sockets/wsserver";
import { AutonomousMission } from "./MissionPlanner";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Footer that is stamped onto EVERY message this service sends. */
export const WA_FOOTER = "Powered by hazu@AlexaInc.github.io";

/** Optional public https image used as the header of interactive cards.
 *  Left empty by default: text-only cards are the most compatible. */
const BRAND_IMAGE_URL = process.env.WA_BRAND_IMAGE_URL || "";

/** Some WhatsApp clients reject native `quick_reply` buttons. Set
 *  WA_QUICK_REPLY=false to fall back to list buttons everywhere. */
const USE_QUICK_REPLY = String(process.env.WA_QUICK_REPLY ?? "true").toLowerCase() !== "false";

/** Multi-file auth state folder (creds.json + keys). Overridable for tests. */
const DEFAULT_SESSION_DIR = process.env.WA_SESSION_DIR || "wasession";
const PAIRING_TIMEOUT_MS = 25_000;
const RECONNECT_DELAY_MS = 5_000;
const RESTART_DELAY_MS = 3_000;

/** The four button replies the mod can hand us, normalised to one string. */
type ButtonReply = {
    id: string | null;
    displayText: string | null;
};

/* ------------------------------------------------------------------ */
/* Number helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Normalise a phone number to E.164 "digital" form: country code included,
 * digits only. `+94 76 604 5156`, `0094 766 045 156` and `94766045156` all
 * become `94766045156`. Local formats (`0766045156`) are rejected because a
 * missing country code makes the bot silently unreachable.
 */
export function normalizeWhatsAppNumber(raw: string | null | undefined): string | null {
    if (!raw) return null;
    let digits = String(raw).trim().replace(/[^\d]/g, "");
    if (!digits) return null;
    if (digits.startsWith("00")) digits = digits.replace(/^0+/, "");
    if (digits.startsWith("0")) return null;            // local format: country code missing
    if (digits.length < 7 || digits.length > 15) return null;
    if (digits.startsWith("0")) return null;
    return digits;
}

export const numberToJid = (digits: string): string => `${digits}@s.whatsapp.net`;

/** "+94766045156@s.whatsapp.net" / "94766045156:12@lid" → "94766045156". */
export const jidToNumber = (jid: string | null | undefined): string =>
    String(jid ?? "").split("@")[0].split(":")[0].replace(/\D/g, "");

const isLid = (jid: string | null | undefined): boolean => String(jid ?? "").endsWith("@lid");

const timeAgo = (ts: number | null | undefined): string => {
    if (!ts) return "never";
    const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
};

/**
 * ".pump_on 60" and ".pump on 60" must reach the same handler, and button ids
 * are plain commands too — so the first token is the command *family* and the
 * rest (inline after `_`/`-` plus everything typed after it) is its arguments.
 */
export function splitCommandTokens(command: string | null, commandText: string): { head: string; args: string } {
    const tokens = (command ?? "").split(/[_\-\s]+/).filter(Boolean);
    const head = (tokens[0] ?? "").toLowerCase();
    const inlineSub = tokens.slice(1).join(" ");
    return { head, args: (inlineSub ? `${inlineSub} ${commandText}` : commandText).trim() };
}

const severityIcon = (severity: string): string =>
    severity === "critical" ? "🔴" : severity === "warning" ? "🟠" : "🔵";

/* ------------------------------------------------------------------ */
/* Parsed message                                                      */
/* ------------------------------------------------------------------ */

export interface ParsedMessage {
    msg: WAMessage;
    msgType: string | null;
    messageContent: any;
    contextInfo: proto.IContextInfo | null | undefined;
    replyInfo: {
        sender: string | null | undefined;
        messageId: string | null | undefined;
        messageText: string;
    } | null;
    text: string;
    command: string | null;
    commandText: string;
    quotedid: string | null | undefined;
    mentionedJids: string[];
    sender: string | null | undefined;
    senderJid: string | null | undefined;
    senderlid: string | null | undefined;
    /** digits-only phone number of the sender when WhatsApp exposes it */
    senderNumber: string;
    isGroup: boolean;
    fromMe: boolean | null | undefined;
    jid: string;
    pushName: string | null | undefined;
    /** true when `text` came from a button/list tap rather than typing */
    isButtonReply: boolean;
}

export type WhatsAppState = "disabled" | "idle" | "pairing" | "connected";

/**
 * Health of the stored session, so the app can say something more useful than
 * "not connected":
 *   active      - connected right now
 *   inactive    - session on disk, service currently off / starting
 *   invalid     - was linked but the session is gone (logged out on the phone,
 *                 wiped by WhatsApp, ...) → needs linking again
 *   not_linked  - nothing was ever paired
 */
export type SessionHealth = "active" | "inactive" | "invalid" | "not_linked";

export interface WhatsAppStatus {
    state: WhatsAppState;
    enabled: boolean;
    ownerNumber: string | null;
    linkedNumber: string | null;
    linkedAt: number | null;
    sessionExists: boolean;
    /** derived session verdict shown as a badge on the Settings card */
    sessionHealth: SessionHealth;
    pairingCode: string | null;
    meNumber: string | null;
    lastError: string | null;
}

/** One contextual reply button (label + the command it sends). */
export interface WhatsAppButton { label: string; id: string; }

export interface PumpButtonInput {
    pumpOnline: boolean;
    pumpOn?: boolean | null;
    autoMode?: boolean | null;
}

/**
 * Pump buttons that match what the pump is doing RIGHT NOW — there is no point
 * offering "PUMP ON" while it is already running, or "PUMP OFF" while it is
 * off. Pure function so it can be unit tested (see the smoke test).
 */
export function pumpButtons(input: PumpButtonInput): WhatsAppButton[] {
    if (!input.pumpOnline) return [{ label: "🚿 Pump offline — status", id: ".pump_status" }];
    if (input.pumpOn) {
        return [
            { label: "🛑 Pump OFF", id: ".pump_off" },
            { label: "📈 Pump status", id: ".pump_status" },
        ];
    }
    return [
        { label: "🚿 Pump ON 60s", id: ".pump_on 60" },
        input.autoMode ? { label: "♻️ Auto OFF", id: ".pump_auto off" } : { label: "♻️ Auto ON", id: ".pump_auto on" },
    ];
}

export interface MissionButtonInput {
    robotOnline: boolean;
    state?: "offline" | "patrolling" | "idle" | "fault" | null;
    hasMission: boolean;
}

/**
 * Mission buttons for the current robot state: pause+stop while patrolling,
 * resume+stop when a loaded mission is paused, deploy when nothing is loaded —
 * and never a "Start" button while the rover is offline or already driving.
 */
export function missionButtons(input: MissionButtonInput): WhatsAppButton[] {
    if (!input.robotOnline) return [{ label: "📡 Robot offline — status", id: ".status" }];
    switch (input.state) {
        case "patrolling":
            return [
                { label: "⏸ Pause patrol", id: ".mission_pause" },
                { label: "🛑 Stop", id: ".stop" },
            ];
        case "fault":
            return [
                { label: "🛑 Stop", id: ".stop" },
                { label: "📈 Mission status", id: ".mission_status" },
            ];
        case "idle":
            return input.hasMission
                ? [
                    { label: "▶️ Resume patrol", id: ".mission_resume" },
                    { label: "🛑 Stop", id: ".stop" },
                ]
                : [
                    { label: "🧭 Deploy mission", id: ".mission" },
                    { label: "📈 Mission status", id: ".mission_status" },
                ];
        default:
            return [{ label: "📊 Status", id: ".status" }];
    }
}

/**
 * WhatsApp bot: pair / unlink lifecycle + owner-gated command handling.
 * Singleton because exactly one WhatsApp session may run per process.
 */
export class WhatsAppService {
    private static instance: WhatsAppService | null = null;

    private state!: AuthenticationState;
    private saveCreds!: () => Promise<void>;
    private WaSocket?: WASocket;
    private db: CHRDatabase | null;
    private readonly sessionPath: string;
    private logger: Logger;

    private waState: WhatsAppState = "idle";
    private pairingCode: string | null = null;
    private lastError: string | null = null;
    private connecting = false;
    private opened = false;
    private pairingRequested = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pairingWaiter: ((code: string | null) => void) | null = null;

    public constructor(logger: Logger = rootLogger, db: CHRDatabase | null = null, sessionPath: string = DEFAULT_SESSION_DIR) {
        this.logger = logger ?? rootLogger;
        this.db = db;
        this.sessionPath = sessionPath;
    }

    public static getInstance(logger: Logger = rootLogger, db: CHRDatabase | null = null): WhatsAppService {
        if (!WhatsAppService.instance) WhatsAppService.instance = new WhatsAppService(logger, db);
        else if (db && !WhatsAppService.instance.db) WhatsAppService.instance.attachDatabase(db);
        return WhatsAppService.instance;
    }

    /** The server creates the database after construction, so it is injected here. */
    public attachDatabase(db: CHRDatabase): this {
        this.db = db;
        return this;
    }

    private requireDb(): CHRDatabase {
        if (!this.db) throw new Error("WhatsApp service has no database attached (call attachDatabase first)");
        return this.db;
    }

    /* ---------------------------------------------------------------- */
    /* Lifecycle: status / init / start / autoStart                      */
    /* ---------------------------------------------------------------- */

    public async getStatus(): Promise<WhatsAppStatus> {
        const settings = await this.requireDb().getWhatsAppSettings();
        const sessionExists = await this.sessionExists();
        return {
            state: this.waState,
            enabled: settings.enabled,
            ownerNumber: settings.ownerNumber,
            linkedNumber: settings.linkedNumber,
            linkedAt: settings.linkedAt,
            sessionExists,
            sessionHealth: this.sessionHealth(sessionExists),
            pairingCode: this.pairingCode,
            meNumber: jidToNumber(this.WaSocket?.user?.id) || null,
            lastError: this.lastError,
        };
    }

    /** Verdict for the stored session (see SessionHealth). */
    private sessionHealth(sessionExists: boolean): SessionHealth {
        if (this.waState === "connected") return "active";
        if (sessionExists) return "inactive";
        return this.pairingCode || this.lastError ? "invalid" : "not_linked";
    }

    private async sessionExists(): Promise<boolean> {
        try {
            await fs.access(path.join(this.sessionPath, "creds.json"));
            return true;
        } catch {
            return false;
        }
    }

    public async init(): Promise<void> {
        const authData = await useMultiFileAuthState(this.sessionPath);
        this.state = authData.state;
        this.saveCreds = authData.saveCreds;
        this.logger.debug('WhatsApp session initialized');
    }

    /** Boot behaviour: only connect when the DB says the service is enabled
     *  AND a session exists on disk. Never auto-pairs a fresh account. */
    public async autoStart(): Promise<void> {
        try {
            const settings = await this.requireDb().getWhatsAppSettings();
            if (!settings.enabled) {
                this.waState = "disabled";
                this.logger.info('WhatsApp service disabled — link an account from Settings → WhatsApp Service.');
                return;
            }
            if (!(await this.sessionExists())) {
                this.waState = "idle";
                this.logger.warn('WhatsApp service is enabled in the DB but no session exists on disk — re-link from Settings.');
                return;
            }
            await this.init();
            await this.start();
        } catch (error) {
            this.lastError = (error as Error)?.message ?? String(error);
            this.logger.error({ error }, 'Failed to auto-start WhatsApp session');
        }
    }

    /** Keep-alive for the old export name (was: initWhatsAppOnStartup). */
    public async startFromSavedSession(): Promise<void> {
        await this.autoStart();
    }

    /** Create the socket (pairing code request happens on the QR update when
     *  the account is not registered yet). */
    public async start(): Promise<void> {
        if (this.waState === "connected" && this.WaSocket?.user) {
            this.logger.info('WhatsApp connection is already active.');
            return;
        }
        if (this.connecting) return;

        this.connecting = true;
        this.opened = false;
        this.pairingRequested = false;

        this.WaSocket = makeWASocket({
            auth: this.state,
            logger: P({ level: "fatal" }),
            printQRInTerminal: false,
        });

        this.WaSocket.ev.on('creds.update', this.saveCreds);

        this.WaSocket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr && !this.WaSocket?.authState.creds.registered) {
                await this.requestPairingCode();
            }

            if (connection === 'open') {
                this.opened = true;
                this.connecting = false;
                this.pairingCode = null;
                this.lastError = null;
                this.waState = "connected";
                const meNumber = jidToNumber(this.WaSocket?.user?.id);
                await this.requireDb().saveWhatsAppSettings({
                    enabled: true,
                    linkedNumber: meNumber || null,
                    linkedAt: Date.now(),
                }).catch((error) => this.logger.error({ error }, 'Failed to persist WhatsApp link state'));
                this.logger.info(`WhatsApp connection open as ${meNumber || "<unknown>"}`);
            }

            if (connection === 'close') {
                this.connecting = false;
                this.opened = false;
                const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
                const reason = lastDisconnect?.error?.message ?? "unknown";

                if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.badSession) {
                    await this.handleLoggedOut();
                    return;
                }

                if (this.waState === "disabled") return;

                // 515 = stream error right after the pairing-code request: WhatsApp
                // wants a clean restart with the same creds (existing behaviour).
                const delay = statusCode === DisconnectReason.restartRequired ? RESTART_DELAY_MS : RECONNECT_DELAY_MS;
                this.logger.warn(`WhatsApp connection closed (${statusCode ?? "?"} ${reason}) — retrying in ${Math.round(delay / 1000)}s`);
                this.scheduleReconnect(delay);
            }
        });

        this.WaSocket.ev.on('messages.upsert', (payload) => void this.onMessagesUpsert(payload));

        this.logger.info('WhatsApp socket created (pairing/connecting…)');
    }

    private scheduleReconnect(delayMs: number): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                this.closeSocket();
                if (!(await this.sessionExists())) return;
                await this.init();
                await this.start();
            } catch (error) {
                this.logger.error({ error }, 'WhatsApp reconnect failed');
                this.scheduleReconnect(RECONNECT_DELAY_MS);
            }
        }, delayMs);
        (this.reconnectTimer as any)?.unref?.();
    }

    private closeSocket(logout = false): void {
        const socket = this.WaSocket;
        this.WaSocket = undefined;
        if (!socket) return;
        try {
            if (logout) void socket.logout().catch(() => undefined);
            else socket.end(new Error('Websocket closed by chrserver'));
        } catch { /* socket already gone */ }
    }

    /** WhatsApp told us the session is dead (unlinked from the phone / banned). */
    private async handleLoggedOut(): Promise<void> {
        this.logger.warn('WhatsApp session was logged out — wiping the local session.');
        this.waState = "idle";
        this.pairingCode = null;
        this.lastError = "Session logged out; link the account again";
        this.closeSocket();
        await this.wipeSession();
        await this.requireDb().saveWhatsAppSettings({ enabled: false, linkedNumber: null, linkedAt: null })
            .catch(() => undefined);
    }

    private async wipeSession(): Promise<void> {
        await fs.rm(path.resolve(this.sessionPath), { recursive: true, force: true }).catch(() => undefined);
    }

    private async waitForPairingCode(timeoutMs: number): Promise<string | null> {
        if (this.pairingCode) return this.pairingCode;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                this.pairingWaiter = null;
                resolve(this.pairingCode);
            }, timeoutMs);
            (timer as any)?.unref?.();
            this.pairingWaiter = (code) => {
                clearTimeout(timer);
                this.pairingWaiter = null;
                resolve(code);
            };
        });
    }

    private async requestPairingCode(): Promise<void> {
        if (this.pairingRequested) return;
        this.pairingRequested = true;
        try {
            const settings = await this.requireDb().getWhatsAppSettings();
            const number = settings.linkedNumber || settings.ownerNumber;
            if (!number) {
                this.lastError = "No number configured to pair";
                return;
            }
            const code = await this.WaSocket?.requestPairingCode(number, 'CROPHBOT');
            if (code) {
                this.pairingCode = code;
                this.waState = "pairing";
                this.logger.info(`WhatsApp pairing code generated for ${number}: ${code}`);
                this.pairingWaiter?.(code);
            }
        } catch (error: any) {
            this.pairingRequested = false;                 // allow a retry on the next QR
            this.lastError = error?.message ?? "Pairing code request failed";
            this.logger.error({ error }, 'WhatsApp pairing code request failed');
            this.pairingWaiter?.(null);
        }
    }

    /* ---------------------------------------------------------------- */
    /* Link / unlink / relink (used by the Settings screen)              */
    /* ---------------------------------------------------------------- */

    /** Pair a (new) WhatsApp account using a pairing code. Any previous
     *  session on disk is removed first, so this always links fresh. The
     *  number must include the country code (e.g. 94766045156). */
    public async link(rawNumber: string): Promise<WhatsAppStatus> {
        const number = normalizeWhatsAppNumber(rawNumber);
        if (!number) {
            throw new Error("Enter the WhatsApp number with its country code and digits only (example: 94766045156)");
        }

        this.closeSocket();
        await this.wipeSession();
        this.pairingCode = null;
        this.lastError = null;
        this.pairingRequested = false;
        this.waState = "pairing";

        const settings = await this.requireDb().getWhatsAppSettings();
        await this.requireDb().saveWhatsAppSettings({
            enabled: true,
            linkedNumber: number,
            linkedAt: null,
            // First link: the owner defaults to the linked number until changed.
            ownerNumber: settings.ownerNumber ?? number,
        });

        await this.init();
        await this.start();

        const code = await this.waitForPairingCode(PAIRING_TIMEOUT_MS);
        if (!code) {
            this.waState = "idle";
            throw new Error(this.lastError ?? "WhatsApp did not return a pairing code — try again");
        }
        return this.getStatus();
    }

    /** Alias used by the "relink with another account" button. */
    public relink(rawNumber: string): Promise<WhatsAppStatus> {
        return this.link(rawNumber);
    }

    /** Delete the session (creds + keys) and stop the service. The owner
     *  number and the other settings are intentionally kept. */
    public async unlink(): Promise<WhatsAppStatus> {
        this.waState = "idle";
        this.pairingCode = null;
        this.lastError = null;
        this.closeSocket(true);
        await this.wipeSession();
        await this.requireDb().saveWhatsAppSettings({ enabled: false, linkedNumber: null, linkedAt: null });
        this.logger.warn('WhatsApp session deleted (unlink).');
        return this.getStatus();
    }

    /**
     * The bot's ON/OFF switch (Settings → WhatsApp Service).
     *
     * OFF only stops the socket and flips the persisted `enabled` flag: the
     * session files stay on disk, so switching back ON reconnects the same
     * account without pairing again. `unlink()` is the destructive variant.
     */
    public async setEnabled(enabled: boolean): Promise<WhatsAppStatus> {
        const db = this.requireDb();

        if (!enabled) {
            this.waState = "disabled";
            this.pairingCode = null;
            this.lastError = null;
            if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
            this.closeSocket();                       // end(), NOT logout(): the session survives
            await db.saveWhatsAppSettings({ enabled: false });
            this.logger.warn('WhatsApp service switched OFF (session kept on disk).');
            return this.getStatus();
        }

        await db.saveWhatsAppSettings({ enabled: true });
        if (!(await this.sessionExists())) {
            this.waState = "idle";                    // nothing to resume — the app must link first
            this.logger.warn('WhatsApp service switched ON but no session exists yet.');
            return this.getStatus();
        }
        if (this.waState !== "connected" && !this.connecting) {
            await this.init();
            await this.start();
        }
        return this.getStatus();
    }

    /** Only change the owner gate number — never touches the session. */
    public async setOwnerNumber(rawNumber: string): Promise<WhatsAppStatus> {
        const number = normalizeWhatsAppNumber(rawNumber);
        if (!number) {
            throw new Error("Enter the owner number with its country code and digits only (example: 94766045156)");
        }
        await this.requireDb().saveWhatsAppSettings({ ownerNumber: number, ownerLids: [] });
        return this.getStatus();
    }

    /** Send a confirmation message to the owner (Settings → "Send test message"). */
    public async sendTestMessage(): Promise<WhatsAppStatus> {
        const settings = await this.requireDb().getWhatsAppSettings();
        if (!this.WaSocket?.user) throw new Error("WhatsApp is not connected yet");
        if (!settings.ownerNumber) throw new Error("Set the owner number first");
        await this.sendText(numberToJid(settings.ownerNumber), "✅ *chrserver WhatsApp service is connected.*\nSend *.menu* to see the available commands.");
        return this.getStatus();
    }

    /* ---------------------------------------------------------------- */
    /* Message parsing                                                   */
    /* ---------------------------------------------------------------- */

    /**
     * Content-type detection copied from alexainc/alexa-v3 (src/bot.js) and
     * extended with the four button-reply shapes, so a tapped button is
     * treated exactly like the spelled-out command.
     */
    public static extractButtonReply(content: any): ButtonReply {
        if (!content) return { id: null, displayText: null };
        if (typeof content.selectedButtonId === "string") {
            return { id: content.selectedButtonId, displayText: content.selectedDisplayText ?? null };
        }
        if (typeof content.singleSelectReply?.selectedRowId === "string") {
            return { id: content.singleSelectReply.selectedRowId, displayText: content.title ?? null };
        }
        if (typeof content.selectedId === "string") {
            return { id: content.selectedId, displayText: content.selectedDisplayText ?? null };
        }
        const paramsJson = content.nativeFlowResponseMessage?.paramsJson;
        if (paramsJson) {
            try {
                const parsed = typeof paramsJson === "string" ? JSON.parse(paramsJson) : paramsJson;
                const id = parsed?.id ?? parsed?.selectedId ?? null;
                if (typeof id === "string") return { id, displayText: parsed?.display_text ?? null };
            } catch { /* not a JSON payload — ignore */ }
        }
        return { id: null, displayText: null };
    }

    private parseMessage(msg: WAMessage): ParsedMessage | null {
        if (!msg || !msg.message) return null;

        let m: any = msg.message;
        if (m.ephemeralMessage) m = m.ephemeralMessage.message;
        if (m.viewOnceMessage) m = m.viewOnceMessage.message;

        const getContentType = (content: any): string | null => {
            if (!content) return null;
            const keys = Object.keys(content);
            const key = keys.find(
                (k) =>
                    (k === "conversation" || k.endsWith("Message")) &&
                    k !== "senderKeyDistributionMessage" &&
                    k !== "messageContextInfo",
            );
            return key || null;
        };

        const msgType = getContentType(m);
        if (!msgType) return null;

        const messageContent = m[msgType];
        if (!messageContent) return null;

        const contextInfo = messageContent.contextInfo;

        const buttonReply = WhatsAppService.extractButtonReply(messageContent);
        // A `conversation` message stores the text as the content itself
        // (msgType === "conversation" → messageContent is a string), which the
        // old content-only lookup missed, so plain typed commands were dropped.
        const plainText = typeof messageContent === "string" ? messageContent : "";
        const text =
            plainText ||
            messageContent.text ||
            messageContent.caption ||
            messageContent.conversation ||
            buttonReply.id ||
            "";

        // Reply (swipe-to-reply) info
        const quotedid = contextInfo?.stanzaId;
        let replyInfo: ParsedMessage["replyInfo"] = null;

        if (contextInfo?.quotedMessage) {
            const quoted: any = contextInfo.quotedMessage;
            const quotedType = getContentType(quoted);
            const quotedContent = quotedType ? quoted[quotedType] : null;
            let quotedText = "";

            if (quotedContent) {
                quotedText =
                    quotedContent.text ||
                    quotedContent.caption ||
                    quotedContent.conversation ||
                    "";
            }

            replyInfo = {
                sender: contextInfo.participant,
                messageId: contextInfo.stanzaId,
                messageText: quotedText,
            };
        }

        const remoteJid = msg.key?.remoteJid || "";
        const isGroup = remoteJid.endsWith("@g.us");
        const isDirectMessage = !isGroup;

        let rawParticipant: string | null | undefined, rawParticipantAlt: string | null | undefined;

        if (isDirectMessage) {
            rawParticipant = remoteJid;
            rawParticipantAlt = (msg.key as any).remoteJidAlt;
        } else {
            rawParticipant = (msg.key as any).participant;
            rawParticipantAlt = (msg.key as any).participantAlt;
        }

        let finalJid: string | null | undefined = null;
        let finalLid: string | null | undefined = null;

        if (rawParticipant?.endsWith("@lid")) {
            finalLid = rawParticipant;
            finalJid = rawParticipantAlt;
        } else if (rawParticipantAlt?.endsWith("@s.whatsapp.net")) {
            finalJid = rawParticipantAlt;
            finalLid = rawParticipant;
        } else {
            finalJid = rawParticipant;
            finalLid = rawParticipantAlt;
        }

        const prefix = /^[./!\\]/;
        const body = text.trim().split(/ +/);
        const commandWithPrefix = body.shift()?.toLowerCase() || "";

        let command: string | null = null;
        let commandText = text;

        if (prefix.test(commandWithPrefix)) {
            command = commandWithPrefix.slice(1);
            commandText = body.join(" ");
        }

        return {
            msg,
            msgType,
            messageContent,
            contextInfo,
            replyInfo,
            text,
            command,
            commandText,
            quotedid,
            mentionedJids: contextInfo?.mentionedJid || [],
            sender: finalLid,
            senderJid: finalJid,
            senderlid: finalLid,
            senderNumber: jidToNumber(finalJid) || jidToNumber(rawParticipantAlt) || "",
            isGroup,
            fromMe: msg.key?.fromMe,
            jid: remoteJid,
            pushName: msg.pushName,
            isButtonReply: Boolean(buttonReply.id),
        };
    }

    /* ---------------------------------------------------------------- */
    /* Owner gate                                                        */
    /* ---------------------------------------------------------------- */

    private async isOwner(p: ParsedMessage): Promise<boolean> {
        const settings = await this.requireDb().getWhatsAppSettings();
        if (!settings.ownerNumber) return false;

        const numbers = [p.senderNumber, jidToNumber(p.senderJid), jidToNumber(p.senderlid)];
        if (numbers.some((n) => n && n === settings.ownerNumber)) {
            // Learn the owner's LID (WhatsApp's phone-number-hiding alias) so
            // the gate keeps working on chats that only expose `@lid`.
            if (isLid(p.senderlid) && p.senderlid && !settings.ownerLids.includes(p.senderlid)) {
                await this.requireDb().saveWhatsAppSettings({ ownerLids: [...settings.ownerLids, p.senderlid] })
                    .catch(() => undefined);
            }
            return true;
        }
        return Boolean(p.senderlid && settings.ownerLids.includes(p.senderlid));
    }

    /* ---------------------------------------------------------------- */
    /* Sending helpers (the footer is a REAL footer on every message)     */
    /* ---------------------------------------------------------------- */

    /** Used only when a client refuses the interactive payload: the footer
     *  then has to ride along inside the text, because a plain text message
     *  has no footer field at all. */
    private withFooter(body: string): string {
        return `${body}\n\n${WA_FOOTER}`;
    }

    /** Raw send — content already carries its own footer field. */
    private async sendRaw(jid: string, content: any, quoted?: WAMessage): Promise<void> {
        if (!this.WaSocket?.user) throw new Error("WhatsApp is not connected");
        await this.WaSocket.sendMessage(jid, content, quoted ? { quoted } : undefined);
    }

    /** Last-resort plain text (footer inline — see withFooter). */
    private async sendPlainFallback(jid: string, body: string, quoted?: WAMessage): Promise<void> {
        await this.sendRaw(jid, { text: this.withFooter(body) }, quoted);
    }

    private quickReply(displayText: string, id: string): any {
        if (USE_QUICK_REPLY) {
            return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: displayText, id }) };
        }
        // Fallback shape for clients that reject quick replies.
        return {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
                title: displayText,
                sections: [{ title: "Actions", rows: [{ header: " ", title: displayText, id }] }],
            }),
        };
    }

    private urlButton(displayText: string, url: string): any {
        return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: displayText, url, merchant_url: url }) };
    }

    private listButton(title: string, sections: Array<{ title: string; rows: Array<{ title: string; description?: string; id: string }> }>): any {
        return {
            name: "single_select",
            buttonParamsJson: JSON.stringify({
                title,
                sections: sections.map((section) => ({
                    title: section.title,
                    rows: section.rows.map((row) => ({ header: " ", title: row.title, description: row.description ?? "", id: row.id })),
                })),
            }),
        };
    }

    /** Map label/id pairs onto native quick-reply buttons. */
    private toQuickReplies(buttons: WhatsAppButton[], max = 3): any[] {
        return buttons.slice(0, Math.max(1, max)).map((b) => this.quickReply(b.label, b.id));
    }

    /** Live inputs for the contextual button builders (one DB + ws round trip). */
    private async actionContext(): Promise<{ pump: PumpButtonInput; mission: MissionButtonInput }> {
        const ws = this.getWs();
        const db = this.requireDb();
        const [irrigation, active] = await Promise.all([
            db.getLatestIrrigationReading(),
            db.getSetting<AutonomousMission | null>("activeMission", null),
        ]);
        const status = ws ? await ws.computeStatus() : null;
        return {
            pump: {
                pumpOnline: ws?.isPumpOnline() ?? false,
                pumpOn: irrigation ? irrigation.pump_on === 1 : null,
                autoMode: irrigation ? irrigation.auto_mode === 1 : null,
            },
            mission: {
                robotOnline: ws?.isRobotOnline() ?? false,
                state: status?.state ?? null,
                hasMission: Boolean(active),
            },
        };
    }

    /**
     * The default button row for any reply. It is built from the live state —
     * the first button is the one pump action that makes sense now, the second
     * is the one robot action that makes sense now, and a status refresh fills
     * the last slot. Nothing is ever hardcoded on/off or start/stop, so the
     * same card is correct while pumping, idling, patrolling or offline.
     */
    private async contextButtons(max = 3, extra: WhatsAppButton[] = []): Promise<any[]> {
        const { pump, mission } = await this.actionContext();
        const groups: WhatsAppButton[][] = [extra, pumpButtons(pump), missionButtons(mission)];
        const merged: WhatsAppButton[] = [];
        for (const group of groups) if (group.length) merged.push(group[0]);
        if (merged.length < max) merged.push({ label: "📊 Status", id: ".status" });
        for (const group of groups.slice(1)) if (group.length > 1 && merged.length < max) merged.push(group[1]);

        const seen = new Set<string>();
        const unique: WhatsAppButton[] = [];
        for (const button of merged) {
            if (seen.has(button.id)) continue;
            seen.add(button.id);
            unique.push(button);
        }
        return this.toQuickReplies(unique, max);
    }

    /** Pump-focused row (pump card, pump results). */
    private async pumpRow(max = 3): Promise<any[]> {
        const { pump } = await this.actionContext();
        const buttons = [...pumpButtons(pump)];
        if (!buttons.some((b) => b.id === ".pump_status")) buttons.push({ label: "📈 Pump status", id: ".pump_status" });
        if (buttons.length < max) buttons.push({ label: "📊 Status", id: ".status" });
        return this.toQuickReplies(buttons, max);
    }

    /** Mission-focused row (mission cards) — pause/stop, resume/stop, deploy. */
    private async missionRow(max = 3, extra: WhatsAppButton[] = []): Promise<any[]> {
        const { mission } = await this.actionContext();
        const buttons = [...extra, ...missionButtons(mission)];
        const seen = new Set<string>();
        const unique: WhatsAppButton[] = [];
        for (const button of buttons) {
            if (seen.has(button.id)) continue;
            seen.add(button.id);
            unique.push(button);
        }
        return this.toQuickReplies(unique, max);
    }

    /**
     * Interactive card: body text + a REAL footer field + native-flow buttons.
     * Every customer-visible reply goes through here, which is why the footer
     * never leaks into the message body. Falls back to a plain text message
     * only if the client refuses the interactive payload, so a command never
     * dies silently.
     */
    private async sendInteractive(
        jid: string,
        options: { title?: string; text: string; buttons: any[]; quoted?: WAMessage; fallbackHint?: string },
    ): Promise<void> {
        if (!this.WaSocket?.user) throw new Error("WhatsApp is not connected");

        const content: any = {
            text: options.text,
            footer: WA_FOOTER,
            interactiveButtons: options.buttons,
        };
        if (options.title) content.title = options.title;
        if (BRAND_IMAGE_URL) {
            delete content.text;
            content.image = { url: BRAND_IMAGE_URL };
            content.caption = options.text;
        }

        try {
            await this.sendRaw(jid, content, options.quoted);
        } catch (error) {
            this.logger.warn({ error }, 'Interactive message failed — falling back to plain text');
            const fallback = options.fallbackHint ? `${options.text}\n\n${options.fallbackHint}` : options.text;
            await this.sendPlainFallback(jid, fallback, options.quoted);
        }
    }

    /**
     * Shorthand used by the read-only answers (.whoami, .blocks, .reports,
     * errors, ...): a card whose buttons are picked from the live state, so the
     * footer is always a footer and every reply offers a relevant next tap.
     */
    private async sendText(jid: string, body: string, quoted?: WAMessage, buttons?: any[]): Promise<void> {
        await this.sendInteractive(jid, {
            text: body,
            quoted,
            buttons: buttons ?? await this.contextButtons(),
        });
    }

    /* ---------------------------------------------------------------- */
    /* Incoming messages                                                 */
    /* ---------------------------------------------------------------- */

    private async onMessagesUpsert(payload: { messages?: WAMessage[]; type?: string }): Promise<void> {
        if (payload?.type !== "notify") return;             // never act on history sync / appends
        for (const msg of payload.messages ?? []) {
            try {
                await this.onMessage(msg);
            } catch (error) {
                this.logger.error({ error }, 'WhatsApp message handling failed');
            }
        }
    }

    private async onMessage(msg: WAMessage): Promise<void> {
        if (!msg?.message || msg.key?.fromMe) return;       // ignore our own messages (no loops)

        const p = this.parseMessage(msg);
        if (!p) return;

        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || remoteJid === "status@broadcast") return;
        if (p.isGroup) return;                              // DM-only bot (keep group chats untouched)

        const first = p.text.trim().split(/\s+/)[0] ?? "";
        const hasPrefix = /^[./!\\]/.test(first);
        if (!hasPrefix && !p.isButtonReply) return;         // plain chatter is ignored

        const settings = await this.requireDb().getWhatsAppSettings();
        if (!settings.ownerNumber) {
            await this.sendText(remoteJid, "⚠️ No owner number is configured yet. Open the *Settings → WhatsApp Service* page in the dashboard and save the owner number (with country code).", msg,
                [this.quickReply("📋 Menu", ".menu")]);
            return;
        }
        if (!(await this.isOwner(p))) {
            await this.sendAccessRestriction(remoteJid, msg);
            return;
        }

        this.logger.info({ from: p.senderNumber || p.senderlid, command: p.text }, 'WhatsApp owner command');

        const { head, args } = splitCommandTokens(p.command, p.commandText);
        await this.handleCommand(head || first.replace(/^[./!\\]/, ""), args, remoteJid, p, msg);
    }

    /** Non-owners get a friendly bilingual wall with contact buttons. */
    private async sendAccessRestriction(jid: string, quoted: WAMessage): Promise<void> {
        const text = `⚠️ *ACCESS RESTRICTION ALERT*

• *English:* This command is restricted to the crop owner only. If you would like to set up your own system, feel free to contact us.
• *Sinhala:* මේ command එක crop owner ට විතරයි use කරන්න පුළුවන්. ඔයාලටත් මේ වගේ system එකක් setup කරගන්න ඕනේ නම් අපේ WhatsApp එක හරහා contact කරන්න පුළුවන්!`;

        await this.sendInteractive(jid, {
            text,
            quoted,
            buttons: [
                this.urlButton("Contact Us 01", "https://wa.me/94766045156"),
                this.urlButton("Contact Us 02", "https://wa.me/94702267847"),
            ],
            fallbackHint: "Contact: wa.me/94766045156 • wa.me/94702267847",
        });
    }

    /* ---------------------------------------------------------------- */
    /* Command router                                                    */
    /* ---------------------------------------------------------------- */

    private async handleCommand(head: string, args: string, jid: string, p: ParsedMessage, quoted: WAMessage): Promise<void> {
        switch (head) {
            case "menu": case "help": case "start":
                return this.sendMenu(jid, quoted);
            case "status": case "robot": case "rs":
                return this.sendStatus(jid, quoted);
            case "telemetry": case "tlm": case "sensors":
                return this.sendTelemetry(jid, quoted);
            case "mission":
                return this.missionCommand(args, jid, quoted);
            case "pump":
                return this.pumpCommand(args, jid, quoted);
            case "alerts":
                return this.sendAlerts(jid, quoted);
            case "reports": case "report":
                return this.sendReports(jid, quoted);
            case "blocks": case "map":
                return this.sendBlocks(jid, quoted);
            case "session": case "link":
                return this.sendSession(jid, quoted);
            case "bot": case "service":
                return this.botCommand(args, jid, quoted);
            case "owner":
                return this.ownerCommand(args, jid, quoted);
            case "whoami":
                return this.sendText(jid, `🆔 *Your identifiers*\n• phone: ${p.senderNumber || "hidden (lid only)"}\n• jid: ${p.senderJid ?? "-"}\n• lid: ${p.senderlid ?? "-"}`, quoted);
            case "stop":
                return this.emergencyStop(jid, quoted);
            case "photo": case "capture":
                return this.robotAction(jid, "cap_photo", undefined, quoted, "📸 Photo capture requested.");
            default:
                return this.sendInteractive(jid, {
                    text: `❓ Unknown command *${head || p.text}*.\nTap a button below or send *.menu* to see everything I can do.`,
                    quoted,
                    buttons: [this.quickReply("📋 Command menu", ".menu")],
                    fallbackHint: "Send .menu for the command list.",
                });
        }
    }

    /* ---------------------------------------------------------------- */
    /* Menu                                                              */
    /* ---------------------------------------------------------------- */

    private async sendMenu(jid: string, quoted: WAMessage): Promise<void> {
        const text = `🌱 *CROP HEALTH ROBOT — CONTROL MENU*
Owner-only. Tap a button, or type the command.

*🤖 Robot*
• .status — robot + mission status
• .mission — deploy / pause / resume / stop
• .stop — emergency stop
• .photo — capture a photo now

*🚿 Irrigation*
• .pump — pump control buttons
• .pump_on 60 • .pump_off
• .pump_auto on|off • .pump_status

*📊 Farm data*
• .telemetry • .alerts • .reports • .blocks

*⚙️ Account*
• .bot on|off — start/stop this bot
• .session — link + session health
• .owner — owner number
• .whoami — your WhatsApp ids`;

        await this.sendInteractive(jid, {
            text,
            quoted,
            // Two live buttons (whatever the pump/robot need right now) + the
            // catalogue, instead of a fixed ON/OFF pair that is wrong half the time.
            buttons: [
                ...await this.contextButtons(2),
                this.listButton("All commands", [
                    {
                        title: "Robot",
                        rows: [
                            { title: "Robot status", description: "online, mode, mission progress", id: ".status" },
                            { title: "Deploy mission", description: "pick a block to patrol", id: ".mission" },
                            { title: "Pause patrol", description: "switch the rover to manual", id: ".mission_pause" },
                            { title: "Resume patrol", description: "continue the loaded mission", id: ".mission_resume" },
                            { title: "Emergency stop", description: "stop movement + pause patrol", id: ".stop" },
                        ],
                    },
                    {
                        title: "Irrigation",
                        rows: [
                            { title: "Run the pump", description: "on for 60 s (no-op if already running)", id: ".pump" },
                            { title: "Stop the pump", description: "off, whatever mode it is in", id: ".pump_off" },
                            { title: "Pump status", description: "soil moisture + mode", id: ".pump_status" },
                        ],
                    },
                    {
                        title: "Farm data",
                        rows: [
                            { title: "Telemetry", description: "temperature, humidity, rain, GPS", id: ".telemetry" },
                            { title: "Alerts", description: "what the server flagged", id: ".alerts" },
                            { title: "Bot switch", description: "turn this WhatsApp service on/off", id: ".bot" },
                        ],
                    },
                ]),
            ],
            fallbackHint: "Type .status, .pump_on 60, .pump_off, .mission, .telemetry …",
        });
    }

    /* ---------------------------------------------------------------- */
    /* Status / telemetry                                                */
    /* ---------------------------------------------------------------- */

    private getWs(): WSServer | null {
        try {
            return WSServer.getInstance();
        } catch {
            return null;
        }
    }

    private async sendStatus(jid: string, quoted: WAMessage): Promise<void> {
        const ws = this.getWs();
        const db = this.requireDb();
        const [sensors, irrigation, unacknowledged] = await Promise.all([
            db.getLatestSensorReading(),
            db.getLatestIrrigationReading(),
            db.countUnacknowledgedAlerts(),
        ]);

        const status = ws ? await ws.computeStatus() : null;
        const robotOnline = ws?.isRobotOnline() ?? false;
        const pumpOnline = ws?.isPumpOnline() ?? false;

        const lines: string[] = [];
        lines.push(`🤖 *Robot:* ${robotOnline ? "ONLINE" : "OFFLINE"}`);
        if (status) {
            lines.push(`• state: *${status.state}* • mode: *${status.mode}*`);
            if (status.missionId) {
                lines.push(`• mission: ${status.missionId} (${status.currentWaypoint ?? 0}/${status.totalWaypoints ?? 0}${status.progress != null ? `, ${Math.round(status.progress * 100)}%` : ""})`);
            }
            if (status.message) lines.push(`• ${status.message}`);
        }
        lines.push(`🚿 *Pump:* ${pumpOnline ? "ONLINE" : "OFFLINE"}${irrigation ? ` • ${irrigation.pump_on ? "RUNNING" : "idle"}${irrigation.auto_mode ? " (auto)" : ""} • soil ${irrigation.soil_moisture != null ? `${irrigation.soil_moisture.toFixed(0)}%` : "--"}` : ""}`);
        if (sensors) {
            lines.push(`🌡 *Last sensor tick* (${timeAgo(sensors.received_at)}): ${sensors.temperature != null ? `${sensors.temperature.toFixed(1)}°C` : "--"} / ${sensors.humidity != null ? `${sensors.humidity.toFixed(0)}%RH` : "--"}${sensors.is_raining ? " • 🌧 raining" : ""}`);
            if (sensors.block_id) lines.push(`📍 block: ${sensors.block_id}${sensors.plant ? ` (${sensors.plant})` : ""}`);
        }
        lines.push(`🔔 unacknowledged alerts: *${unacknowledged}*`);

        await this.sendInteractive(jid, {
            title: "Robot status",
            text: lines.join("\n"),
            quoted,
            buttons: await this.contextButtons(3, [{ label: "🔄 Refresh", id: ".status" }]),
            fallbackHint: "Commands: .status • .pump • .mission • .telemetry",
        });
    }

    private async sendTelemetry(jid: string, quoted: WAMessage): Promise<void> {
        const db = this.requireDb();
        const [sensors, irrigation, trail] = await Promise.all([
            db.getLatestSensorReading(),
            db.getLatestIrrigationReading(),
            db.getRecentTrail(1),
        ]);
        const location = trail[0];

        const lines = ["📡 *Live telemetry*"];
        lines.push(sensors
            ? `• temperature: ${sensors.temperature != null ? `${sensors.temperature.toFixed(1)}°C` : "--"}\n• humidity: ${sensors.humidity != null ? `${sensors.humidity.toFixed(0)}%` : "--"}\n• rain: ${sensors.rain_percent != null ? `${sensors.rain_percent.toFixed(0)}%` : "--"}${sensors.is_raining ? " (raining)" : ""}\n• front/left/right: ${[sensors.dist_forward_cm, sensors.dist_left_cm, sensors.dist_right_cm].map((d) => (d != null ? `${d.toFixed(0)}cm` : "--")).join(" / ")}\n• measured: ${timeAgo(sensors.received_at)}`
            : "• no sensor tick stored yet");
        lines.push(irrigation
            ? `🚿 *Irrigation*\n• soil moisture: ${irrigation.soil_moisture != null ? `${irrigation.soil_moisture.toFixed(0)}%` : "--"} (threshold ${irrigation.threshold ?? "--"})\n• pump: ${irrigation.pump_on ? "ON" : "OFF"} • mode: ${irrigation.auto_mode ? "AUTO" : "MANUAL"}\n• measured: ${timeAgo(irrigation.received_at)}`
            : "🚿 *Irrigation*\n• no reading stored yet");
        lines.push(location
            ? `📍 *Position* (${timeAgo(location.received_at)})\n• ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}${location.altitude != null ? ` • ${location.altitude.toFixed(0)} m` : ""}${location.satellites != null ? ` • ${location.satellites} sats` : ""}`
            : "📍 *Position*\n• no GPS fix yet");

        await this.sendInteractive(jid, {
            title: "Telemetry",
            text: lines.join("\n\n"),
            quoted,
            buttons: await this.contextButtons(3, [{ label: "🔄 Refresh", id: ".telemetry" }]),
            fallbackHint: "Commands: .telemetry • .status • .alerts",
        });
    }

    /* ---------------------------------------------------------------- */
    /* Mission                                                           */
    /* ---------------------------------------------------------------- */

    private async missionCommand(args: string, jid: string, quoted: WAMessage): Promise<void> {
        const [sub = "", ...rest] = args.split(/\s+/).filter(Boolean);
        const ws = this.getWs();
        if (!ws) return this.sendText(jid, "⚠️ Server socket gateway is not ready yet.", quoted,
            [this.quickReply("🔄 Retry", ".status"), this.quickReply("📋 Menu", ".menu")]);

        switch (sub.toLowerCase()) {
            case "": case "menu": case "help": case "deploy": {
                const map = await ws.getFieldMap();
                if (sub.toLowerCase() === "deploy" && rest.length) {
                    const blocks = rest.join(" ").toLowerCase() === "all" ? [] : rest;
                    return this.deployMission(ws, blocks, jid, quoted);
                }
                if (!map || !map.blocks.length) {
                    return this.sendText(jid, "⚠️ No field map is saved yet. Draw the field blocks in the dashboard's *Mapping* screen first, then come back.", quoted);
                }
                return this.sendInteractive(jid, {
                    title: "Mission",
                    text: `🗺 *Field blocks* — pick the block the robot should patrol.\n${map.blocks.map((b) => `• *${b.name}* (${b.plant}) — id \`${b.id}\``).join("\n")}`,
                    quoted,
                    // Live mission buttons first (pause/stop while driving, resume
                    // when paused, deploy when idle) + the block picker.
                    buttons: [
                        ...await this.missionRow(2),
                        this.listButton("Choose a block", [
                            {
                                title: "Blocks",
                                rows: map.blocks.slice(0, 7).map((b) => ({
                                    title: `${b.name} — ${b.plant}`,
                                    description: `Patrol block ${b.id}`,
                                    id: `.mission_deploy ${b.id}`,
                                })),
                            },
                            {
                                title: "Other",
                                rows: [
                                    { title: "All blocks", description: "Deploy every mapped block", id: ".mission_deploy all" },
                                    { title: "Mission status", description: "progress of the loaded mission", id: ".mission_status" },
                                ],
                            },
                        ]),
                    ],
                    fallbackHint: `Type: .mission deploy ${map.blocks[0].id}   (or "all")`,
                });
            }
            case "deploy":
            case "start": {
                const blocks = rest.join(" ").toLowerCase() === "all" ? [] : rest;
                return this.deployMission(ws, blocks, jid, quoted);
            }
            case "pause": case "manual":
                return this.robotAck(jid, await ws.setRobotMode("manual", "whatsapp"), "bot", quoted);
            case "resume": case "continue":
                return this.robotAck(jid, await ws.setRobotMode("autonomous", "whatsapp"), "bot", quoted);
            case "stop": case "end":
                return this.emergencyStop(jid, quoted);
            case "status": case "info": {
                const active = await this.requireDb().getSetting<AutonomousMission | null>("activeMission", null);
                const status = await ws.computeStatus();
                const lines = [`🤖 state: *${status.state}* • mode: *${status.mode}*`];
                if (status.missionId) lines.push(`• mission ${status.missionId}: ${status.currentWaypoint ?? 0}/${status.totalWaypoints ?? 0} waypoints`);
                if (status.message) lines.push(`• ${status.message}`);
                if (active) lines.push(`• loaded blocks: ${active.blocks.join(", ")} (${active.waypoints.length} waypoints)`);
                else lines.push("• no mission loaded");
                return this.sendInteractive(jid, {
                    title: "Mission status",
                    text: lines.join("\n"),
                    quoted,
                    buttons: await this.missionRow(3, [{ label: "🔄 Refresh", id: ".mission_status" }]),
                    fallbackHint: "Commands: .mission_status • .mission_resume • .mission_pause • .stop",
                });
            }
            default:
                return this.sendText(jid, `❓ Unknown mission sub-command *${sub}*.\nTry: .mission · .mission deploy <block> · .mission_status · .mission_pause · .mission_resume · .mission stop`, quoted);
        }
    }

    private async deployMission(ws: WSServer, blocks: string[], jid: string, quoted: WAMessage): Promise<void> {
        const result = await ws.deployMission(blocks.length ? { blocks } : {}, "whatsapp");
        await this.sendRobotResult(jid, result.success, result.success ? `🚀 ${result.message}` : `❌ Mission not deployed: ${result.reason}`, quoted);
    }

    private async emergencyStop(jid: string, quoted: WAMessage): Promise<void> {
        const ws = this.getWs();
        if (!ws) return this.sendText(jid, "⚠️ Server socket gateway is not ready yet.", quoted,
            [this.quickReply("🔄 Retry", ".status"), this.quickReply("📋 Menu", ".menu")]);
        const stopped = await ws.controlRobot("stop", undefined, "whatsapp");
        const paused = await ws.setRobotMode("manual", "whatsapp");
        const ok = stopped.success;
        await this.sendRobotResult(
            jid,
            ok,
            ok
                ? `🛑 *Emergency stop sent.* Movement halted${paused.success ? " and the patrol is paused (resume with .mission_resume)" : ""}.`
                : `❌ Stop failed: ${stopped.reason}`,
            quoted,
        );
    }

    private async robotAction(jid: string, action: string, data: unknown, quoted: WAMessage, successText: string): Promise<void> {
        const ws = this.getWs();
        if (!ws) return this.sendText(jid, "⚠️ Server socket gateway is not ready yet.", quoted,
            [this.quickReply("🔄 Retry", ".status"), this.quickReply("📋 Menu", ".menu")]);
        const result = await ws.controlRobot(action, data, "whatsapp");
        await this.sendRobotResult(jid, result.success, result.success ? successText : `❌ ${action} failed: ${result.reason}`, quoted);
    }

    private async pumpAction(jid: string, action: string, data: unknown, quoted: WAMessage, successText: string): Promise<void> {
        const ws = this.getWs();
        if (!ws) return this.sendText(jid, "⚠️ Server socket gateway is not ready yet.", quoted,
            [this.quickReply("🔄 Retry", ".status"), this.quickReply("📋 Menu", ".menu")]);
        const result = await ws.controlPump(action, data, "whatsapp");
        await this.sendRobotResult(jid, result.success, result.success ? successText : `❌ ${action} failed: ${result.reason}`, quoted);
    }

    /** Generic result reply — the buttons are rebuilt from the state the command
     *  just produced, so a "Pump ON" result offers "Pump OFF" (and vice versa)
     *  without a single hardcoded pair. */
    private async sendRobotResult(jid: string, ok: boolean, text: string, quoted: WAMessage, buttons?: any[]): Promise<void> {
        const defaults = ok
            ? await this.contextButtons(3)
            : [this.quickReply("📊 Status", ".status"), this.quickReply("📋 Menu", ".menu")];
        await this.sendInteractive(jid, {
            text,
            quoted,
            buttons: buttons ?? defaults,
            fallbackHint: "Commands: .status • .menu",
        });
    }

    private async robotAck(jid: string, result: { success: boolean; message?: string; reason?: string }, _kind: "bot", quoted: WAMessage): Promise<void> {
        await this.sendRobotResult(jid, result.success, result.success ? `✅ ${result.message}` : `❌ ${result.reason}`, quoted);
    }

    /* ---------------------------------------------------------------- */
    /* Pump                                                              */
    /* ---------------------------------------------------------------- */

    private async pumpCommand(args: string, jid: string, quoted: WAMessage): Promise<void> {
        const [sub = "", value = ""] = args.split(/\s+/).filter(Boolean);
        const action = sub.toLowerCase();

        if (!action) {
            const irrigation = await this.requireDb().getLatestIrrigationReading();
            return this.sendInteractive(jid, {
                title: "Water pump",
                text: irrigation
                    ? `🚿 *Pump:* ${irrigation.pump_on ? "RUNNING" : "OFF"} • *mode:* ${irrigation.auto_mode ? "AUTO" : "MANUAL"}\n• soil moisture: ${irrigation.soil_moisture != null ? `${irrigation.soil_moisture.toFixed(0)}%` : "--"} (threshold ${irrigation.threshold ?? "--"})\n• updated ${timeAgo(irrigation.received_at)}`
                    : "🚿 No pump reading stored yet — is the ESP32-C3 controller online?",
                quoted,
                buttons: [
                    ...await this.pumpRow(2),
                    this.listButton("More", [
                        {
                            title: "Pump control",
                            rows: [
                                { title: "Pump ON 2 min", description: "run irrigation for 120 s", id: ".pump_on 120" },
                                { title: "Auto mode ON", description: "moisture-threshold irrigation", id: ".pump_auto on" },
                                { title: "Auto mode OFF", description: "manual control only", id: ".pump_auto off" },
                                { title: "Pump status", description: "soil moisture + mode", id: ".pump_status" },
                                { title: "Stop irrigation", description: "abort an irrigation run", id: ".pump_stop" },
                            ],
                        },
                    ]),
                ],
                fallbackHint: "Commands: .pump_on 60 • .pump_off • .pump_auto on • .pump_status",
            });
        }

        switch (action) {
            case "on": case "start": {
                const seconds = Math.max(1, Math.min(3600, Number(value) || 60));
                return this.pumpAction(jid, "pump_on", { durationSeconds: seconds }, quoted, `🚿 *Pump ON for ${seconds}s.*`);
            }
            case "off": case "stop":
                return this.pumpAction(jid, "pump_off", undefined, quoted, "🛑 *Pump OFF.*");
            case "auto": {
                const enabled = !["off", "false", "0", "no"].includes(value.toLowerCase());
                return this.pumpAction(jid, "pump_auto", { enabled }, quoted, `♻️ *Auto irrigation ${enabled ? "ENABLED" : "DISABLED"}.*`);
            }
            case "status": case "info": {
                const irrigation = await this.requireDb().getLatestIrrigationReading();
                return this.sendText(jid, irrigation
                    ? `🚿 *Pump status*\n• pump: ${irrigation.pump_on ? "RUNNING" : "OFF"}\n• mode: ${irrigation.auto_mode ? "AUTO" : "MANUAL"}\n• soil moisture: ${irrigation.soil_moisture != null ? `${irrigation.soil_moisture.toFixed(0)}%` : "--"}\n• threshold: ${irrigation.threshold ?? "--"}\n• updated: ${timeAgo(irrigation.received_at)}`
                    : "🚿 No pump reading stored yet.", quoted);
            }
            case "threshold": {
                const percent = Math.max(5, Math.min(90, Number(value) || 35));
                await this.requireDb().setSetting("fleetConfig", {
                    ...(await this.getWs()?.getFleetConfig() ?? {}),
                    irrigationThresholdPercent: percent,
                });
                return this.pumpAction(jid, "set_irrigation_threshold", { moisturePercent: percent }, quoted, `💧 *Irrigation threshold set to ${percent}%.*`);
            }
            case "irrigate": {
                if (!value) return this.sendText(jid, "Usage: `.pump irrigate <blockId> [seconds]`", quoted);
                const seconds = Math.max(1, Math.min(3600, Number(args.split(/\s+/)[2]) || 120));
                return this.pumpAction(jid, "irrigate_block", { blockId: value, durationSeconds: seconds }, quoted, `💦 *Irrigating block ${value} for ${seconds}s.*`);
            }
            default:
                return this.sendText(jid, `❓ Unknown pump sub-command *${sub}*.\nTry: .pump · .pump_on 60 · .pump_off · .pump_auto on|off · .pump_status · .pump_stop`, quoted);
        }
    }

    /* ---------------------------------------------------------------- */
    /* Farm data                                                         */
    /* ---------------------------------------------------------------- */

    private async sendAlerts(jid: string, quoted: WAMessage): Promise<void> {
        const alerts = await this.requireDb().listAlerts(5);
        if (!alerts.length) return this.sendText(jid, "🔔 No alerts stored yet.", quoted);
        const lines = alerts.map((a) => `${severityIcon(a.severity)} *${a.title}*${a.acknowledged_at ? " (ack)" : ""} — ${timeAgo(a.created_at)}\n${a.description ? `   ${a.description}` : ""}`.trimEnd());
        const unacknowledged = alerts.filter((a) => !a.acknowledged_at).length;
        await this.sendInteractive(jid, {
            title: "Recent alerts",
            text: `🔔 *Latest ${alerts.length} alerts* (${unacknowledged} unacknowledged)\n\n${lines.join("\n\n")}`,
            quoted,
            buttons: await this.contextButtons(3, [{ label: "🔔 Refresh alerts", id: ".alerts" }]),
            fallbackHint: "Commands: .alerts • .status",
        });
    }

    private async sendReports(jid: string, quoted: WAMessage): Promise<void> {
        const reports = await this.requireDb().getReports(1);
        if (!reports.length) return this.sendText(jid, "📄 No analysis report yet — it is generated automatically when a patrol finishes.", quoted);
        const report = reports[0] as any;
        const averages: Array<{ className: string; averageConfidence: number; samples: number }> = report.report?.averages ?? [];
        const lines = [
            `📄 *Latest report* (#${report.id}, ${timeAgo(report.created_at)})`,
            report.summary,
            `• images: ${report.report?.imageCount ?? 0} • blocks: ${(report.report?.blocks ?? []).join(", ") || "-"}`,
            ...averages.slice(0, 6).map((a) => `• ${a.className.replace(/_+/g, " ")} — ${(a.averageConfidence * 100).toFixed(0)}% (${a.samples})`),
        ];
        await this.sendText(jid, lines.join("\n"), quoted);
    }

    private async sendBlocks(jid: string, quoted: WAMessage): Promise<void> {
        const map = await this.requireDb().getSetting<FieldMapMessage | null>("fieldMap", null);
        if (!map || !map.blocks.length) return this.sendText(jid, "🗺 No field map saved yet — draw it in the dashboard's Mapping screen.", quoted);
        const lines = map.blocks.map((b) => `• *${b.name}* — ${b.plant} (id \`${b.id}\`, row ${b.rowSpacingM ?? "-"}m / scan ${b.scanSpacingM ?? "-"}m)`);
        await this.sendText(jid, `🗺 *${map.name || "Field"}* — ${map.blocks.length} block(s)\n${lines.join("\n")}`, quoted);
    }

    private static readonly HEALTH_LABEL: Record<SessionHealth, string> = {
        active: "✅ active (connected)",
        inactive: "⚪️ inactive (session on disk, bot switched off)",
        invalid: "❌ invalid — the session was logged out, link the account again",
        not_linked: "➖ no account linked yet",
    };

    private async sendSession(jid: string, quoted: WAMessage): Promise<void> {
        const status = await this.getStatus();
        const lines = [
            "🔗 *WhatsApp service*",
            `• bot: *${status.enabled ? "ON" : "OFF"}*`,
            `• session: ${WhatsAppService.HEALTH_LABEL[status.sessionHealth]}`,
            `• state: *${status.state}*`,
            `• linked number: ${status.linkedNumber ?? "-"}`,
            `• owner number: ${status.ownerNumber ?? "-"}`,
            `• linked: ${status.linkedAt ? timeAgo(status.linkedAt) : "never"}`,
        ];
        if (status.pairingCode) lines.push(`• pairing code: *${status.pairingCode}*`);
        if (status.lastError) lines.push(`• last error: ${status.lastError}`);
        lines.push("", status.enabled ? "Switch the bot off with `.bot off`." : "Switch the bot on with `.bot on`.");

        await this.sendInteractive(jid, {
            title: "WhatsApp session",
            text: lines.join("\n"),
            quoted,
            buttons: status.enabled
                ? [this.quickReply("🛑 Bot OFF", ".bot off"), this.quickReply("📊 Status", ".status"), this.quickReply("📋 Menu", ".menu")]
                : [this.quickReply("🚀 Bot ON", ".bot on"), this.quickReply("📊 Status", ".status"), this.quickReply("📋 Menu", ".menu")],
            fallbackHint: "Manage linking from the dashboard: Settings → WhatsApp Service.",
        });
    }

    /** `.bot` — the WhatsApp service's own ON/OFF switch, from the chat. */
    private async botCommand(args: string, jid: string, quoted: WAMessage): Promise<void> {
        const [sub = ""] = args.split(/\s+/).filter(Boolean);
        const action = sub.toLowerCase();

        if (["on", "start", "enable", "resume"].includes(action)) {
            const status = await this.setEnabled(true);
            if (!status.sessionExists) {
                return this.sendText(jid, "⚠️ No linked account yet — pair one from *Settings → WhatsApp Service* in the dashboard first (`.session` shows the state).", quoted,
                    [this.quickReply("🔗 Session state", ".session"), this.quickReply("📋 Menu", ".menu")]);
            }
            return this.sendText(jid, `🚀 *WhatsApp bot ON* — reconnecting with the saved session.\n• state: ${status.state}`, quoted,
                [this.quickReply("🔗 Session state", ".session"), this.quickReply("📊 Status", ".status")]);
        }

        if (["off", "stop", "disable", "pause"].includes(action)) {
            // Send the confirmation BEFORE the socket goes away, then switch off.
            await this.sendText(jid, "🛑 *WhatsApp bot OFF.*\nThe session stays saved on the server — say `.bot on` (or use the dashboard switch) to start it again.", quoted,
                [this.quickReply("📋 Menu", ".menu")]);
            setTimeout(() => { void this.setEnabled(false).catch(() => undefined); }, 750);
            return;
        }

        const status = await this.getStatus();
        return this.sendInteractive(jid, {
            title: "WhatsApp bot switch",
            text: `🔌 *Bot:* ${status.enabled ? "ON" : "OFF"}\n• session: ${WhatsAppService.HEALTH_LABEL[status.sessionHealth]}\n• state: ${status.state}`,
            quoted,
            buttons: status.enabled
                ? [this.quickReply("🛑 Turn OFF", ".bot off"), this.quickReply("🔗 Session", ".session")]
                : [this.quickReply("🚀 Turn ON", ".bot on"), this.quickReply("🔗 Session", ".session")],
            fallbackHint: "Usage: .bot on • .bot off • .session",
        });
    }

    private async ownerCommand(args: string, jid: string, quoted: WAMessage): Promise<void> {
        const [sub = "", value = ""] = args.split(/\s+/).filter(Boolean);
        if (sub.toLowerCase() === "set") {
            const number = normalizeWhatsAppNumber(value);
            if (!number) return this.sendText(jid, "❌ Send the number with its country code, digits only — e.g. `.owner set 94766045156`\n(Local formats like 0766045156 are rejected.)", quoted);
            await this.setOwnerNumber(number);
            return this.sendText(jid, `✅ Owner number saved: *${number}*\nOnly this number can control the robot from now on.`, quoted);
        }
        const settings = await this.requireDb().getWhatsAppSettings();
        await this.sendText(jid, `👤 *Owner number:* ${settings.ownerNumber ?? "not set"}\n${settings.ownerLids.length ? `• learned LIDs: ${settings.ownerLids.length}` : ""}\nChange it with \`.owner set 94XXXXXXXXX\` or from the dashboard's Settings → WhatsApp Service page.`, quoted);
    }
}
