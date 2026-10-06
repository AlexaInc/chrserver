/**
 * Push notifications to the operator's phone.
 *
 * Until now a safety alert only lived inside the app: the phone buzzed only if
 * somebody was looking at the screen, and the WhatsApp message went out but the
 * phone's own notification shade stayed silent. This service is the missing leg:
 * the server holds the push tokens of the phones that asked to be notified and
 * posts an Expo push message whenever an alert is raised.
 *
 * Why the Expo push API: the app is an Expo build on both Android and iOS, so
 * one HTTP call reaches both stores' push services without this server holding
 * FCM/APNs credentials. If the app is not an Expo build any more, point
 * `PUSH_URL` at your own gateway that accepts the same body — the payload is
 * plain JSON (`{ to, title, body, data, priority, channelId }`).
 *
 * Behaviour that matters in the field:
 *   • tokens live in the database (setting key `pushDevices`), so a restart does
 *     not lose them, and the same phone re-registering does not duplicate;
 *   • `PUSH_MIN_SEVERITY` (default `warning`) keeps informational chatter off the
 *     lock screen — critical = rain, petrol empty, failsafe;
 *   • a token Expo reports as `DeviceNotRegistered` is dropped automatically, so
 *     a reinstalled phone is not pushed to for ever;
 *   • delivery failures are retried, and the outcome is always visible in
 *     `GET /api/push` instead of disappearing into a log line;
 *   • `PUSH_ENABLED=false` (or no devices) makes every send a no-op — a server
 *     without the app installed never talks to Expo at all.
 */

import { logger as defaultLogger } from "../logger";

export type PushSeverity = "info" | "warning" | "critical";

export interface PushDevice {
    /** Expo push token: `ExponentPushToken[xxxx]` / `ExpoPushToken[xxxx]` */
    token: string;
    /** 'android' | 'ios' | 'web' | 'unknown' */
    platform: string;
    /** free text the operator can recognise the phone by */
    label?: string;
    /** which app user registered it, when known */
    userId?: string;
    addedAt: number;
    lastSeenAt: number;
    /** delivery attempts that failed for a reason that is not the token */
    failures?: number;
    /** set when Expo says the token is dead — no longer pushed to */
    disabledReason?: string;
}

export interface PushMessage {
    title: string;
    body: string;
    severity?: PushSeverity;
    /** extra data handed to the app (alert id, screen to open, …) */
    data?: Record<string, unknown>;
}

export interface PushAttempt {
    at: number;
    ok: boolean;
    sent: number;
    failed: number;
    reason?: string;
}

export interface PushStatus {
    enabled: boolean;
    url: string;
    minSeverity: PushSeverity;
    devices: number;
    activeDevices: number;
    sent: number;
    failed: number;
    lastSentAt: number | null;
    lastError: string | null;
    lastAttempt: PushAttempt | null;
    history: PushAttempt[];
}

export interface PushStore {
    getSetting<T>(key: string, fallback: T): Promise<T>;
    setSetting<T>(key: string, value: T): Promise<void>;
}

export const PUSH_DEVICES_KEY = "pushDevices";
export const MAX_PUSH_DEVICES = 20;
export const DEFAULT_MIN_SEVERITY: PushSeverity = "warning";
export const MAX_NOTIFICATION_BODY = 220;

const SEVERITY_RANK: Record<PushSeverity, number> = { info: 0, warning: 1, critical: 2 };

/** Expo's own validation, kept here so a bad token never reaches the network. */
export function isValidPushToken(raw: unknown): boolean {
    const token = typeof raw === "string" ? raw.trim() : "";
    return /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_\-:]+\]$/.test(token);
}

export function isPushSeverity(value: unknown): value is PushSeverity {
    return value === "info" || value === "warning" || value === "critical";
}

export function minSeverityFromEnv(raw: unknown): PushSeverity {
    return isPushSeverity(raw) ? raw : DEFAULT_MIN_SEVERITY;
}

/** Android channel + priority: a rain alert must wake the phone, an FYI must not. */
export function channelFor(severity: PushSeverity): { channelId: string; priority: "default" | "high" | "max" } {
    if (severity === "critical") return { channelId: "safety", priority: "max" };
    if (severity === "warning") return { channelId: "alerts", priority: "high" };
    return { channelId: "alerts", priority: "default" };
}

export function severityAtLeast(severity: PushSeverity, min: PushSeverity): boolean {
    return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/** Long alert descriptions are trimmed here, not by the phone. */
export function clipBody(text: string, max = MAX_NOTIFICATION_BODY): string {
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** `ExponentPushToken[abc…xyz]` — enough to recognise a phone, no replay value. */
export function maskPushToken(token: string): string {
    const inner = String(token ?? "").replace(/^.*\[|\]$/g, "");
    if (inner.length <= 8) return `${inner.slice(0, 2)}…`;
    return `${inner.slice(0, 4)}…${inner.slice(-4)}`;
}

export interface PushServiceOptions {
    store: PushStore;
    /** override for tests: the fake Expo endpoint */
    url?: string;
    enabled?: boolean;
    minSeverity?: PushSeverity;
    accessToken?: string;
    /** injected in tests so nothing waits on the network */
    fetchImpl?: typeof fetch;
    logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
    /** retry policy (attempts after the first try) */
    retries?: number;
    retryDelayMs?: number;
}

export class PushService {
    private static instance: PushService | null = null;

    private readonly store: PushStore;
    private readonly url: string;
    private readonly enabled: boolean;
    private readonly minSeverity: PushSeverity;
    private readonly accessToken?: string;
    private readonly doFetch: typeof fetch;
    private readonly log: NonNullable<PushServiceOptions["logger"]>;
    private readonly retries: number;
    private readonly retryDelayMs: number;

    private stats = { sent: 0, failed: 0, lastSentAt: null as number | null, lastError: null as string | null };
    private history: PushAttempt[] = [];

    private constructor(opts: PushServiceOptions) {
        this.store = opts.store;
        this.url = opts.url ?? process.env.PUSH_URL ?? process.env.EXPO_PUSH_URL ?? "https://exp.host/--/api/v2/push/send";
        this.enabled = opts.enabled ?? String(process.env.PUSH_ENABLED ?? "true").toLowerCase() !== "false";
        this.minSeverity = opts.minSeverity ?? minSeverityFromEnv(process.env.PUSH_MIN_SEVERITY);
        this.accessToken = opts.accessToken ?? process.env.EXPO_ACCESS_TOKEN ?? undefined;
        this.doFetch = opts.fetchImpl ?? fetch;
        this.log = opts.logger ?? {
            info: (m) => defaultLogger.info(m),
            warn: (m) => defaultLogger.warn(m),
            error: (m) => defaultLogger.error(m),
        };
        this.retries = opts.retries ?? 2;
        this.retryDelayMs = opts.retryDelayMs ?? 400;
    }

    public static getInstance(opts?: PushServiceOptions): PushService {
        if (!PushService.instance) {
            if (!opts) throw new Error("PushService.getInstance() needs options on first call");
            PushService.instance = new PushService(opts);
        }
        return PushService.instance;
    }

    /**
     * The same instance, or null when nothing wired the service up yet.
     * Alert raising uses this: a server started without index.ts (a test, a
     * tool) must still be able to raise alerts — push is a bonus, never a
     * reason for the alert itself to fail.
     */
    public static getInstanceOrNull(): PushService | null {
        return PushService.instance;
    }

    /** Test helper: drop the singleton so the next call rebuilds it. */
    public static resetInstance(): void {
        PushService.instance = null;
    }

    /* ---------------------------------------------------------------- */
    /* Devices                                                           */
    /* ---------------------------------------------------------------- */

    public async listDevices(): Promise<PushDevice[]> {
        const stored = await this.store.getSetting<PushDevice[]>(PUSH_DEVICES_KEY, []);
        return Array.isArray(stored) ? stored.filter((d) => d && typeof d.token === "string") : [];
    }

    /** Registering the same token twice updates it instead of duplicating. */
    public async registerDevice(input: {
        token: string;
        platform?: string;
        label?: string;
        userId?: string;
    }): Promise<{ ok: boolean; error?: string; device?: PushDevice; devices: number }> {
        const token = String(input.token ?? "").trim();
        if (!isValidPushToken(token)) {
            return { ok: false, error: "not-a-push-token", devices: (await this.listDevices()).length };
        }
        const devices = await this.listDevices();
        const now = Date.now();
        const platform = ["android", "ios", "web"].includes(String(input.platform)) ? String(input.platform) : "unknown";
        const existing = devices.find((d) => d.token === token);
        let device: PushDevice;
        if (existing) {
            // Reinstalled app / new login: clear the tombstone, refresh the rest.
            device = {
                ...existing,
                platform,
                label: input.label ?? existing.label,
                userId: input.userId ?? existing.userId,
                lastSeenAt: now,
                failures: 0,
                disabledReason: undefined,
            };
            const i = devices.findIndex((d) => d.token === token);
            devices[i] = device;
        } else {
            if (devices.length >= MAX_PUSH_DEVICES) {
                // Oldest first: a farm phone that has not been seen in months is
                // the one to drop, and the operator keeps the phones in use.
                devices.sort((a, b) => (a.lastSeenAt ?? 0) - (b.lastSeenAt ?? 0));
                devices.shift();
            }
            device = { token, platform, label: input.label, userId: input.userId, addedAt: now, lastSeenAt: now, failures: 0 };
            devices.push(device);
        }
        await this.store.setSetting(PUSH_DEVICES_KEY, devices);
        this.log.info(`[PUSH] device registered (${platform}, ${maskPushToken(token)}) — ${devices.length} total`);
        return { ok: true, device, devices: devices.length };
    }

    public async removeDevice(token: string): Promise<{ ok: boolean; devices: number }> {
        const devices = await this.listDevices();
        const next = devices.filter((d) => d.token !== token);
        await this.store.setSetting(PUSH_DEVICES_KEY, next);
        return { ok: next.length !== devices.length, devices: next.length };
    }

    /** Only tokens that Expo has not buried — these are the ones we push to. */
    public activeDevices(devices: PushDevice[]): PushDevice[] {
        return devices.filter((d) => !d.disabledReason);
    }

    /* ---------------------------------------------------------------- */
    /* Sending                                                           */
    /* ---------------------------------------------------------------- */

    /** Fire an alert to every registered phone, honouring the severity floor. */
    public async notifyAlert(alert: {
        severity: PushSeverity;
        title: string;
        description?: string;
        source?: string;
        id?: number;
    }): Promise<{ ok: boolean; skipped?: string; sent?: number }> {
        if (!this.enabled) return { ok: false, skipped: "disabled" };
        if (!severityAtLeast(alert.severity, this.minSeverity)) {
            return { ok: false, skipped: `below-${this.minSeverity}` };
        }
        const devices = this.activeDevices(await this.listDevices());
        if (devices.length === 0) return { ok: false, skipped: "no-devices" };
        const res = await this.send(
            devices.map((d) => this.buildMessage(d, {
                title: alert.title,
                body: alert.description || alert.title,
                severity: alert.severity,
                data: { type: "alert", alertId: alert.id ?? null, severity: alert.severity, source: alert.source ?? "server" },
            })),
        );
        return { ok: res.ok, sent: res.sent };
    }

    /** The Settings → "Send test notification" button, and the verify suite. */
    public async sendTest(text = "Test notification — if you can see this, alerts will reach this phone."): Promise<{ ok: boolean; sent: number; failed: number; reason?: string }> {
        if (!this.enabled) return { ok: false, sent: 0, failed: 0, reason: "disabled" };
        const devices = this.activeDevices(await this.listDevices());
        if (devices.length === 0) return { ok: false, sent: 0, failed: 0, reason: "no-devices" };
        const res = await this.send(
            devices.map((d) => this.buildMessage(d, {
                title: "AI Crop Robot",
                body: clipBody(text),
                severity: "warning",
                data: { type: "test" },
            })),
        );
        return { ok: res.ok, sent: res.sent, failed: res.failed, reason: res.reason };
    }

    private buildMessage(device: PushDevice, msg: PushMessage): Record<string, unknown> {
        const severity = msg.severity ?? "warning";
        const { channelId, priority } = channelFor(severity);
        return {
            to: device.token,
            title: msg.title,
            body: clipBody(msg.body),
            data: { ...(msg.data ?? {}), severity },
            sound: severity === "critical" ? "default" : undefined,
            priority,
            channelId,
            // A safety alert must survive the phone's battery saver.
            ttl: severity === "critical" ? 3600 : 600,
        };
    }

    /**
     * POST to the push gateway, in Expo's batch format (one array per call).
     * Network errors are retried; a per-ticket `DeviceNotRegistered` retires the
     * token instead of retrying it for ever.
     */
    public async send(messages: Record<string, unknown>[]): Promise<{ ok: boolean; sent: number; failed: number; reason?: string }> {
        if (messages.length === 0) return { ok: false, sent: 0, failed: 0, reason: "empty" };
        let lastError: string | null = null;

        for (let attempt = 0; attempt <= this.retries; attempt++) {
            try {
                const res = await this.doFetch(this.url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Accept: "application/json",
                        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
                    },
                    body: JSON.stringify(messages.length === 1 ? messages[0] : messages),
                });
                if (!res.ok) {
                    lastError = `http-${res.status}`;
                    // 4xx (other than 429) is our bug, not a flaky network: stop.
                    if (res.status < 500 && res.status !== 429) {
                        this.record(false, 0, messages.length, lastError);
                        return { ok: false, sent: 0, failed: messages.length, reason: lastError };
                    }
                } else {
                    const body: any = await res.json().catch(() => null);
                    const tickets: any[] = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
                    let failed = 0;
                    for (const ticket of tickets) {
                        if (ticket?.status === "error") {
                            failed++;
                            const code = String(ticket?.details?.error ?? ticket?.message ?? "error");
                            const token = String(ticket?.to ?? "");
                            if (code === "DeviceNotRegistered" || code === "InvalidCredentials") {
                                await this.retireDevice(token, code);
                            }
                            lastError = code;
                        }
                    }
                    const sent = Math.max(0, messages.length - failed);
                    this.stats.sent += sent;
                    this.stats.failed += failed;
                    if (sent > 0) this.stats.lastSentAt = Date.now();
                    if (lastError) this.stats.lastError = lastError;
                    this.record(failed === 0, sent, failed, failed ? (lastError ?? "ticket-error") : undefined);
                    return { ok: failed === 0, sent, failed, reason: failed ? (lastError ?? "ticket-error") : undefined };
                }
            } catch (e: any) {
                lastError = e?.message ?? "network";
            }
            if (attempt < this.retries) await this.sleep(this.retryDelayMs * (attempt + 1));
        }

        this.stats.failed += messages.length;
        this.stats.lastError = lastError;
        this.record(false, 0, messages.length, lastError ?? "failed");
        this.log.warn(`[PUSH] send failed: ${lastError}`);
        return { ok: false, sent: 0, failed: messages.length, reason: lastError ?? "failed" };
    }

    private async retireDevice(token: string, reason: string): Promise<void> {
        if (!token) return;
        const devices = await this.listDevices();
        const next = devices.map((d) => (d.token === token ? { ...d, disabledReason: reason } : d));
        await this.store.setSetting(PUSH_DEVICES_KEY, next);
        this.log.warn(`[PUSH] ${maskPushToken(token)} retired (${reason}) — the app must register again`);
    }

    private record(ok: boolean, sent: number, failed: number, reason?: string): void {
        const attempt: PushAttempt = { at: Date.now(), ok, sent, failed, reason };
        this.history = [attempt, ...this.history].slice(0, 20);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /* ---------------------------------------------------------------- */
    /* Status                                                            */
    /* ---------------------------------------------------------------- */

    public async getStatus(): Promise<PushStatus> {
        const devices = await this.listDevices();
        return {
            enabled: this.enabled,
            url: this.url,
            minSeverity: this.minSeverity,
            devices: devices.length,
            activeDevices: this.activeDevices(devices).length,
            sent: this.stats.sent,
            failed: this.stats.failed,
            lastSentAt: this.stats.lastSentAt,
            lastError: this.stats.lastError,
            lastAttempt: this.history[0] ?? null,
            history: this.history,
        };
    }

    /** Public view for the app: tokens are masked, the user does not need them. */
    public async getPublicStatus(): Promise<PushStatus & { deviceList: Array<Omit<PushDevice, "token"> & { token: string }> }> {
        const status = await this.getStatus();
        const devices = await this.listDevices();
        return {
            ...status,
            devices: devices.length,
            deviceList: devices.map((d) => ({ ...d, token: maskPushToken(d.token) })),
        };
    }
}
