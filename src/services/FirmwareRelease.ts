/**
 * src/services/FirmwareRelease.ts — the firmware store and the OTA queue.
 *
 * The operator uploads a compiled `.bin` in the admin panel; the panel then
 * pushes an `ota` command to every online board of that target. The board
 * downloads the image from THIS server (the same host it already talks to) and
 * flashes itself, so nothing has to be unplugged again.
 *
 * Why a store here and not GitHub releases: the pump/rover are usually on the
 * field gateway, and the rover runs in CHRH_FORCE_GATEWAY_MODE where GitHub is
 * not reachable. A file on this server is always reachable for the board that
 * can already reach the socket.
 *
 * Files live in FIRMWARE_ROOT (default ./firmware) as
 *     <root>/<target>/<version>.bin
 * plus an index.json holding the metadata and the PENDING update. The pending
 * entry is what makes an update finally reach a board that was switched off at
 * the moment the operator pressed the button: the server re-sends the command
 * as soon as that board announces itself again (see WSServer `device_hello`).
 *
 * Safety rails that exist because a wrong image bricking a board is the worst
 * outcome here:
 *   * a build is only ever sent to a board whose compiled FW_TARGET matches the
 *     target folder - the firmware checks this again and refuses the mismatch;
 *   * a failed download/flash is retried at most FIRMWARE_OTA_MAX_ATTEMPTS
 *     times per device, then the queue entry is dropped and the operator is
 *     alerted instead of the board re-flashing itself forever;
 *   * success is not taken from the device's word: the pending entry is only
 *     cleared when the board comes back (after its reboot) reporting the new
 *     version in `device_hello`.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { logger } from "../logger";

const env = (key: string, fallback: string): string => {
    const v = process.env[key];
    return v === undefined || v === "" ? fallback : v;
};
const envNum = (key: string, fallback: number): number => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) ? v : fallback;
};

/** A stored firmware image. */
export interface FirmwareBuild {
    target: string;
    version: string;
    name: string;
    file: string;
    size: number;
    md5: string;
    sha256: string;
    notes?: string;
    uploadedAt: number;
    uploadedBy?: string;
}

/** The update the operator asked for; kept until it is confirmed on the board. */
export interface FirmwarePending {
    target: string;
    version: string;
    at: number;
    by?: string;
    /** per deviceId: how many times the command has been sent */
    attempts: Record<string, number>;
}

export interface FirmwareTargetStatus {
    target: string;
    latest: Omit<FirmwareBuild, "file"> | null;
    builds: Omit<FirmwareBuild, "file">[];
    pending: (Omit<FirmwarePending, "attempts"> & { attempts: number }) | null;
}

export interface FirmwareStatus {
    enabled: boolean;
    root: string;
    maxAttempts: number;
    targets: FirmwareTargetStatus[];
}

/** What WSServer should do for a board that just said hello. */
export type FirmwareHelloDecision =
    | { action: "none" }
    | { action: "complete"; version: string }
    | { action: "gave-up"; version: string; attempts: number }
    | { action: "push"; build: FirmwareBuild; version: string };

interface FirmwareIndex {
    builds: FirmwareBuild[];
    pending: Record<string, FirmwarePending>;
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** Public download path the firmware turns into `<serverBaseUrl><path>`. */
export const firmwarePath = (target: string, version: string): string =>
    `/api/firmware/${encodeURIComponent(target)}/bin/${encodeURIComponent(version)}`;

export class FirmwareRelease {
    private static instance: FirmwareRelease | null = null;

    static getInstance(): FirmwareRelease {
        if (!FirmwareRelease.instance) FirmwareRelease.instance = new FirmwareRelease();
        return FirmwareRelease.instance;
    }

    readonly enabled: boolean = env("FIRMWARE_OTA_ENABLED", "1") !== "0";
    readonly root: string = path.resolve(env("FIRMWARE_ROOT", "firmware"));
    readonly maxAttempts: number = Math.max(1, envNum("FIRMWARE_OTA_MAX_ATTEMPTS", 3));
    private readonly indexFile = path.join(this.root, "index.json");
    private builds: FirmwareBuild[] = [];
    private pending: Record<string, FirmwarePending> = {};

    private constructor() {
        try {
            fs.mkdirSync(this.root, { recursive: true });
        } catch (error) {
            logger.error({ error, root: this.root }, "[OTA] firmware root is not writable");
        }
        this.load();
        this.rescan();
        const pending = Object.values(this.pending);
        logger.info(
            { root: this.root, builds: this.builds.length, pending: pending.map((p) => `${p.target}@${p.version}`) },
            "[OTA] firmware store ready",
        );
    }

    /* ------------------------------------------------------------------ */
    /* persistence                                                         */
    /* ------------------------------------------------------------------ */

    private load(): void {
        try {
            if (!fs.existsSync(this.indexFile)) return;
            const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as Partial<FirmwareIndex>;
            this.builds = Array.isArray(raw.builds) ? raw.builds.filter((b) => b && b.target && b.version) : [];
            this.pending = raw.pending && typeof raw.pending === "object" ? raw.pending : {};
        } catch (error) {
            logger.warn({ error }, "[OTA] index.json unreadable — starting with an empty firmware store");
            this.builds = [];
            this.pending = {};
        }
    }

    private save(): void {
        try {
            const payload: FirmwareIndex = { builds: this.builds, pending: this.pending };
            fs.writeFileSync(this.indexFile, JSON.stringify(payload, null, 2));
        } catch (error) {
            logger.error({ error }, "[OTA] could not write index.json");
        }
    }

    /** Picks up images that were copied into the root by hand (or restored). */
    private rescan(): void {
        let added = 0;
        try {
            for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
                if (!entry.isDirectory() || !SLUG.test(entry.name)) continue;
                const dir = path.join(this.root, entry.name);
                for (const file of fs.readdirSync(dir)) {
                    if (!file.toLowerCase().endsWith(".bin")) continue;
                    const version = file.slice(0, -4);
                    if (this.get(entry.name, version)) continue;
                    const full = path.join(dir, file);
                    const data = fs.readFileSync(full);
                    const stat = fs.statSync(full);
                    this.builds.push({
                        target: entry.name,
                        version,
                        name: file,
                        file: full,
                        size: data.length,
                        md5: crypto.createHash("md5").update(data).digest("hex"),
                        sha256: crypto.createHash("sha256").update(data).digest("hex"),
                        uploadedAt: stat.mtimeMs,
                        notes: "imported from disk",
                    });
                    added++;
                }
            }
        } catch (error) {
            logger.warn({ error }, "[OTA] rescan failed");
        }
        if (added) {
            logger.info({ added }, "[OTA] imported firmware images found on disk");
            this.save();
        }
    }

    /* ------------------------------------------------------------------ */
    /* reads                                                              */
    /* ------------------------------------------------------------------ */

    list(): FirmwareBuild[] {
        return [...this.builds].sort((a, b) => b.uploadedAt - a.uploadedAt);
    }

    get(target: string, version: string): FirmwareBuild | undefined {
        return this.builds.find((b) => b.target === target && b.version === version);
    }

    latest(target: string): FirmwareBuild | undefined {
        return this.list().find((b) => b.target === target);
    }

    targets(): string[] {
        return [...new Set(this.builds.map((b) => b.target))].sort();
    }

    pendingFor(target: string): FirmwarePending | undefined {
        return this.pending[target];
    }

    pendingAll(): FirmwarePending[] {
        return Object.values(this.pending);
    }

    status(): FirmwareStatus {
        return {
            enabled: this.enabled,
            root: this.root,
            maxAttempts: this.maxAttempts,
            targets: this.targets().map((target) => {
                const builds = this.list().filter((b) => b.target === target);
                const pending = this.pending[target];
                // `file` is a server-side path: the panel gets the metadata only.
                const publicBuild = ({ file: _file, ...rest }: FirmwareBuild): Omit<FirmwareBuild, "file"> => rest;
                return {
                    target,
                    latest: builds[0] ? publicBuild(builds[0]) : null,
                    builds: builds.map(publicBuild),
                    pending: pending
                        ? {
                            target: pending.target,
                            version: pending.version,
                            at: pending.at,
                            by: pending.by,
                            attempts: Object.values(pending.attempts).reduce((a, b) => a + b, 0),
                        }
                        : null,
                };
            }),
        };
    }

    /* ------------------------------------------------------------------ */
    /* writes                                                             */
    /* ------------------------------------------------------------------ */

    saveBuild(input: { target: string; version: string; data: Buffer; notes?: string; uploadedBy?: string }): FirmwareBuild {
        const target = String(input.target || "").trim();
        const version = String(input.version || "").trim();
        if (!SLUG.test(target)) throw new Error("target must be a short slug like 'rover' or 'pump-c3'");
        if (!SLUG.test(version)) throw new Error("version must be a short slug like '2026-10-07-arc-avoid'");
        if (!input.data?.length) throw new Error("the uploaded file is empty");

        const dir = path.join(this.root, target);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${version}.bin`);
        fs.writeFileSync(file, input.data);

        const build: FirmwareBuild = {
            target,
            version,
            name: `${version}.bin`,
            file,
            size: input.data.length,
            md5: crypto.createHash("md5").update(input.data).digest("hex"),
            sha256: crypto.createHash("sha256").update(input.data).digest("hex"),
            notes: input.notes?.trim() || undefined,
            uploadedAt: Date.now(),
            uploadedBy: input.uploadedBy,
        };
        this.builds = this.builds.filter((b) => !(b.target === target && b.version === version));
        this.builds.push(build);
        this.save();
        logger.info(
            { target, version, size: build.size, md5: build.md5, sha256: build.sha256.slice(0, 12) },
            "[OTA] firmware stored",
        );
        return build;
    }

    removeBuild(target: string, version: string): boolean {
        const build = this.get(target, version);
        if (!build) return false;
        this.builds = this.builds.filter((b) => b !== build);
        try {
            fs.rmSync(build.file, { force: true });
        } catch (error) {
            logger.warn({ error, file: build.file }, "[OTA] could not delete the image file");
        }
        const pending = this.pending[target];
        if (pending && pending.version === version) delete this.pending[target];
        this.save();
        logger.info({ target, version }, "[OTA] firmware removed");
        return true;
    }

    markPending(target: string, version: string, by?: string): FirmwarePending {
        const build = this.get(target, version);
        if (!build) throw new Error(`no ${version} build for ${target}`);
        const entry: FirmwarePending = { target, version, at: Date.now(), by, attempts: {} };
        this.pending[target] = entry;
        this.save();
        logger.info({ target, version, by }, "[OTA] update queued");
        return entry;
    }

    clearPending(target: string, reason: string): void {
        if (!this.pending[target]) return;
        const { version } = this.pending[target];
        delete this.pending[target];
        this.save();
        logger.info({ target, version, reason }, "[OTA] queue entry cleared");
    }

    /** Records that the command went out, so the retry budget is per device. */
    notePushed(deviceId: string, target: string, version: string): void {
        const entry = this.pending[target];
        if (!entry || entry.version !== version) return;
        entry.attempts[deviceId] = (entry.attempts[deviceId] ?? 0) + 1;
        this.save();
    }

    /**
     * A board just announced itself. Decide whether it needs the pending image:
     *   * it already runs the pending version  -> the update landed, clear it;
     *   * it runs something else              -> send the command (bounded).
     */
    noteDeviceFirmware(deviceId: string, target: string | undefined, firmware: string | undefined): FirmwareHelloDecision {
        if (!target || !firmware) return { action: "none" };
        const entry = this.pending[target];
        if (!entry) return { action: "none" };
        if (!this.get(target, entry.version)) {
            // the image was deleted while the update was queued
            this.clearPending(target, "image no longer available");
            return { action: "none" };
        }
        if (firmware === entry.version) {
            const version = entry.version;
            this.clearPending(target, `${deviceId} reports the new version`);
            return { action: "complete", version };
        }
        const attempts = entry.attempts[deviceId] ?? 0;
        if (attempts >= this.maxAttempts) {
            this.clearPending(target, `${deviceId} failed ${attempts}x`);
            return { action: "gave-up", version: entry.version, attempts };
        }
        return { action: "push", build: this.get(target, entry.version)!, version: entry.version };
    }

    /** The command the firmware understands (action "ota"). */
    static otaCommand(build: FirmwareBuild): Record<string, unknown> {
        return {
            action: "ota",
            data: {
                target: build.target,
                version: build.version,
                md5: build.md5,
                sha256: build.sha256,
                size: build.size,
                path: firmwarePath(build.target, build.version),
            },
        };
    }
}
