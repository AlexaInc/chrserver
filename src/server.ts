import express, { Response, Request, Express, NextFunction } from "express";
import multer from "multer";
import cors from "cors";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger";
import { config } from "./config/config";
import { WSServer, FieldMapMessage, blockAt, FleetConfig, DEFAULT_FLEET_CONFIG } from "./sockets/wsserver";
import { LoadedPlantModel, predictPlant } from "./services/LoadAimodels";
import { CHRDatabase } from "../db/Sqlight";
import { WhatsAppService, normalizeWhatsAppNumber } from "./services/WhatsAppService";
import { WebAppRelease } from "./services/WebAppRelease";
import { PushService } from "./services/PushService";
import { FirmwareRelease, firmwarePath } from "./services/FirmwareRelease";
import { FIRMWARE_PAGE_HTML } from "./admin/firmwarePage";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// Firmware images are flashed as-is, so they get their own (bigger) limit.
const firmwareUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
export const sessions = new Map<string, string>();

export interface ServerConfig { port: number; domain: string; }

/** A plant class name counts as "healthy" if it contains this word — matches the
 *  PlantVillage-style class naming used by every model in src/models/*\/classes.json
 *  (e.g. "Tomato___healthy", "Potato___healthy"). */
const isHealthyClass = (className: string): boolean => /healthy/i.test(className);

function toCsv(rows: Array<Record<string, unknown>>): string {
    if (!rows.length) return "";
    const headers = Object.keys(rows[0]);
    const esc = (v: unknown) => {
        const s = v == null ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

export class Server {
    app: Express = express();
    public port: number;
    domain: string;
    private models: LoadedPlantModel[] = [];
    private db!: CHRDatabase;

    constructor({ port, domain }: ServerConfig) { this.port = port; this.domain = domain; }

    configureMiddleware(): this {
        this.app.use(express.json({ limit: "10mb" }));
        this.app.use(cors({ origin: true, methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization", "X-Device-Token"], credentials: true }));
        this.app.use(express.urlencoded({ extended: true }));
        return this;
    }

    setupRoutes(options: { models: LoadedPlantModel[]; db: CHRDatabase }): this {
        this.models = options.models;
        this.db = options.db;

        this.app.get("/health", (_req, res) => {
            const web = WebAppRelease.getInstance().getStatus();
            res.send({
                ok: true,
                service: "chrserver",
                time: Date.now(),
                models: this.models.map((m) => m.plant),
                webApp: {
                    serving: web.serving,
                    release: web.tag || null,
                    asset: web.assetName,
                    downloadedAt: web.downloadedAt,
                    lastResult: web.lastResult,
                    lastCheckAt: web.lastCheckAt,
                },
            });
        });

        this.app.post("/auth/login", (req, res) => {
            const { username, password, nonce } = req.body ?? {};
            if (!username || !password || !nonce) return res.status(400).send({ ok: false, message: "username, password and nonce are required" });
            const hash = (value: string) => crypto.createHash("sha256").update(value + String(nonce)).digest("hex");
            if (username !== hash(config.ADMIN_USERNAME) || password !== hash(config.ADMIN_PASS)) return res.status(401).send({ ok: false, message: "invalid username or password" });
            const token = hash(config.jwt_secret + crypto.randomBytes(16).toString("hex"));
            sessions.set(token, config.ADMIN_USERNAME);
            setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000).unref();
            return res.send({ token, expiresIn: 86400, user: { username: "Operator", role: "admin" } });
        });

        /* ---------------------------------------------------------------- */
        /* Field map                                                         */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/field-map", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, map: await this.db.getSetting<FieldMapMessage | null>("fieldMap", null) }); } catch (e) { next(e); }
        });
        this.app.put("/api/field-map", this.authorizeClient, async (req, res, next) => {
            try {
                await this.db.setSetting("fieldMap", req.body);
                WSServer.getInstance().io.emit("message.upsert", { Type: "map", Message: req.body });
                WSServer.getInstance().io.to("esp_32_room").emit("control_command", { command: { action: "field_map", data: req.body } });
                res.send({ ok: true });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Crops                                                             */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/crops", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, crops: await this.db.getCropBatches() }); } catch (e) { next(e); }
        });
        this.app.get("/api/crops/export.csv", this.authorizeClient, async (_req, res, next) => {
            try {
                const crops = await this.db.getCropBatches();
                res.set("Content-Type", "text/csv").set("Content-Disposition", "attachment; filename=crop-batches.csv");
                res.send(toCsv(crops.map((c) => ({ id: c.id, crop: c.crop, block: c.block ?? "", plantedAt: c.planted_at ?? "", notes: c.notes ?? "", createdAt: new Date(c.created_at).toISOString() }))));
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Reports (AI image-analysis batch results)                        */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/reports", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, reports: await this.db.getReports(50) }); } catch (e) { next(e); }
        });

        // Photo collections exist independently of analysis reports. Running,
        // completed, manual and autonomous patrol photos are all visible here.
        this.app.get("/api/photo-collections", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, collections: await this.db.getPhotoCollections(50) }); } catch (e) { next(e); }
        });
        this.app.post("/api/photo-collections/:id/analyze", this.authorizeClient, async (req, res, next) => {
            try {
                const patrolId = Number(req.params.id);
                const scans = await this.db.getPatrolScans(patrolId);
                if (!scans.length) return res.status(404).send({ ok: false, message: "Collection has no photos" });
                for (const scan of scans) {
                    const model = this.models.find((m) => m.plant === scan.plant);
                    if (!model) continue;
                    const predictions = await predictPlant(model, await fs.readFile(scan.image_path), 5);
                    await this.db.updateScanPredictions(scan.id, predictions);
                }
                const refreshed = await this.db.getPatrolScans(patrolId);
                const missionId = refreshed[0]?.mission_id || `manual-${patrolId}`;
                const report = await this.db.buildMissionReport(missionId, patrolId);
                const reportId = await this.db.replacePatrolReport(patrolId, "manual",
                    `Manually analyzed ${refreshed.length} photos`, report);
                WSServer.getInstance().io.to("authorized_room").emit("message.upsert", {
                    Type: "report", Message: { id: reportId, missionId, report }
                });
                res.send({ ok: true, reportId, report });
            } catch (e) { next(e); }
        });
        this.app.delete("/api/scans/:id", this.authorizeClient, async (req, res, next) => {
            try {
                const scan = await this.db.deleteScan(Number(req.params.id));
                if (!scan) return res.status(404).send({ ok: false, message: "Photo not found" });
                await fs.unlink(scan.image_path).catch(() => undefined);
                res.send({ ok: true });
            } catch (e) { next(e); }
        });
        this.app.delete("/api/photo-collections/:id", this.authorizeClient, async (req, res, next) => {
            try {
                const paths = await this.db.deletePhotoCollection(Number(req.params.id));
                await Promise.all(paths.map((file) => fs.unlink(file).catch(() => undefined)));
                res.send({ ok: true, deletedPhotos: paths.length });
            } catch (e) { next(e); }
        });
        this.app.get("/api/manual-patrol", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, patrol: await this.db.getSetting<any>("manualPatrol", null) }); }
            catch (e) { next(e); }
        });
        this.app.post("/api/manual-patrol/start", this.authorizeClient, async (req, res, next) => {
            try {
                const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
                const block = map?.blocks.find((b) => b.id === String(req.body?.blockId));
                if (!block) return res.status(400).send({ ok: false, message: "Select a valid field block" });
                const patrolId = await this.db.startPatrol(`Manual patrol: ${block.name}`, "manual", [block.id]);
                const context = { patrolId, missionId: `manual-${patrolId}`, blockId: block.id,
                    blockName: block.name, plant: block.plant, startedAt: Date.now() };
                await this.db.setSetting("manualPatrol", context);
                res.send({ ok: true, patrol: context });
            } catch (e) { next(e); }
        });
        this.app.post("/api/manual-patrol/end", this.authorizeClient, async (_req, res, next) => {
            try {
                const context = await this.db.getSetting<any>("manualPatrol", null);
                if (!context) return res.status(409).send({ ok: false, message: "No manual patrol is running" });
                await this.db.completePatrol(context.patrolId);
                const report = await this.db.buildMissionReport(context.missionId, context.patrolId);
                const reportId = await this.db.replacePatrolReport(context.patrolId, "auto",
                    `Manual patrol ${context.blockName} completed with ${(report as any).imageCount} photos`, report);
                await this.db.setSetting("manualPatrol", null);
                res.send({ ok: true, reportId, report });
            } catch (e) { next(e); }
        });
        this.app.get("/api/reports/:id/export.csv", this.authorizeClient, async (req, res, next) => {
            try {
                const report = await this.db.getReportById(Number(req.params.id));
                if (!report) return res.status(404).send({ ok: false, message: "Report not found" });
                const scans: any[] = report.report?.scans ?? [];
                const rows = scans.map((s) => ({
                    blockId: s.block_id, plant: s.plant, scanPoint: s.scan_point, side: s.side,
                    topClass: s.predictions?.[0]?.className ?? "", topConfidence: s.predictions?.[0]?.confidence ?? "",
                    capturedAt: new Date(s.created_at).toISOString(),
                }));
                res.set("Content-Type", "text/csv").set("Content-Disposition", `attachment; filename=report-${report.id}.csv`);
                res.send(toCsv(rows));
            } catch (e) { next(e); }
        });
        this.app.get("/api/scans/recent", this.authorizeClient, async (req, res, next) => {
            try { res.send({ ok: true, scans: await this.db.getRecentScans(Number(req.query.limit) || 20) }); } catch (e) { next(e); }
        });
        // Serves the actual captured photo for a scan (thumbnails in the
        // client's Reports/AI Scan screens). Accepts ?token= like the CSV
        // export routes, since <Image source={{uri}}> can't set headers.
        this.app.get("/api/scans/:id/image", this.authorizeClient, async (req, res, next) => {
            try {
                const scan = await this.db.getScanById(Number(req.params.id));
                if (!scan) return res.status(404).send({ ok: false, message: "Scan not found" });
                res.sendFile(path.resolve(scan.image_path));
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Alerts                                                            */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/alerts", this.authorizeClient, async (req, res, next) => {
            try {
                const onlyUnacknowledged = req.query.unacknowledged === "1";
                res.send({ ok: true, alerts: await this.db.listAlerts(Number(req.query.limit) || 50, onlyUnacknowledged) });
            } catch (e) { next(e); }
        });
        this.app.post("/api/alerts/ack", this.authorizeClient, async (req, res, next) => {
            try {
                const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : undefined;
                const changed = await this.db.acknowledgeAlerts(ids);
                res.send({ ok: true, changed });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Sensor / irrigation history (Analytics screen)                    */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/sensors/history", this.authorizeClient, async (req, res, next) => {
            try {
                const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
                res.send({ ok: true, readings: await this.db.getSensorHistory(Date.now() - hours * 3_600_000) });
            } catch (e) { next(e); }
        });
        this.app.get("/api/irrigation/history", this.authorizeClient, async (req, res, next) => {
            try {
                const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
                res.send({ ok: true, readings: await this.db.getIrrigationHistory(Date.now() - hours * 3_600_000) });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Fleet config (Settings screen — only fields the backend/robot use) */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/config", this.authorizeClient, async (_req, res, next) => {
            try {
                // Always answer with the complete shape: a config record saved
                // before the speed limits existed must not surface as undefined.
                const stored = await this.db.getSetting<Partial<FleetConfig>>("fleetConfig", {});
                res.send({ ok: true, config: { ...DEFAULT_FLEET_CONFIG, ...stored } });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* One-shot state snapshot — lets the client render real data       */
        /* immediately on load, before the first live socket message.       */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/state", this.authorizeClient, async (_req, res, next) => {
            try {
                const ws = WSServer.getInstance();
                const [trail, sensors, irrigation, map, activeMission, fleetConfig, unacknowledgedAlerts, recentAlerts, recentPatrols] = await Promise.all([
                    this.db.getRecentTrail(1),
                    this.db.getLatestSensorReading(),
                    this.db.getLatestIrrigationReading(),
                    this.db.getSetting<FieldMapMessage | null>("fieldMap", null),
                    this.db.getSetting<any>("activeMission", null),
                    this.db.getSetting<FleetConfig>("fleetConfig", DEFAULT_FLEET_CONFIG),
                    this.db.countUnacknowledgedAlerts(),
                    this.db.listAlerts(10),
                    this.db.getRecentPatrols(5),
                ]);
                res.send({
                    ok: true,
                    location: trail[0] ?? null,
                    sensors: sensors ?? null,
                    irrigation: irrigation ?? null,
                    fieldMap: map,
                    hasFieldMap: Boolean(map && map.blocks?.length),
                    activeMission,
                    fleetConfig,
                    devices: { robotOnline: ws.isRobotOnline(), pumpOnline: ws.isPumpOnline() },
                    status: await ws.computeStatus(),
                    alerts: { unacknowledged: unacknowledgedAlerts, recent: recentAlerts },
                    recentPatrols,
                    safety: await ws.getSafetyState(),
                    wellThresholds: await this.db.getSetting<Record<string, number>>("wellThresholds", {}),
                });
            } catch (e) { next(e); }
        });

        /**
         * Rain / petrol safety state + the two manual reports.
         *
         * The app shows this on the Robot screen; the operator can also start the
         * sequence by hand ("I see rain") or report an empty tank, which is then
         * forwarded to every saved owner number.
         */
        this.app.get("/api/safety", this.authorizeClient, async (_req, res, next) => {
            try {
                const ws = WSServer.getInstance();
                res.send({
                    ok: true,
                    safety: await ws.getSafetyState(),
                    wellThresholds: await this.db.getSetting<Record<string, number>>("wellThresholds", {}),
                    rainThresholdPercent: Number(process.env.RAIN_THRESHOLD_PERCENT ?? 60),
                    owners: (await WhatsAppService.getInstance(logger, this.db).getStatus()).ownerNumbers,
                });
            } catch (e) { next(e); }
        });

        this.app.post("/api/safety/rain", this.authorizeClient, async (req, res, next) => {
            try {
                const ack = await WSServer.getInstance().runRainSequence(
                    "operator", Number(req.body?.rainPercent), "dashboard");
                res.send({ ok: ack.success, ack, safety: await WSServer.getInstance().getSafetyState() });
            } catch (e) { next(e); }
        });

        this.app.post("/api/safety/fuel-empty", this.authorizeClient, async (req, res, next) => {
            try {
                const ack = await WSServer.getInstance().reportFuelEmpty({
                    note: req.body?.note, runMinutes: Number(req.body?.runMinutes) || undefined,
                }, "dashboard");
                res.send({ ok: ack.success, ack, safety: await WSServer.getInstance().getSafetyState() });
            } catch (e) { next(e); }
        });

        this.app.post("/api/safety/fuel-refilled", this.authorizeClient, async (_req, res, next) => {
            try {
                const ack = await WSServer.getInstance().clearFuelEmpty("dashboard");
                res.send({ ok: ack.success, ack, safety: await WSServer.getInstance().getSafetyState() });
            } catch (e) { next(e); }
        });

        /**
         * Self-update feed for the app.
         *
         * The app asks its own server (which can hold a GitHub token and cache the
         * answer) instead of hammering the public GitHub API from every phone. The
         * reply carries the newest release AND the web build this server is
         * currently serving, so the web app knows whether a reload is enough.
         */
        this.app.get("/api/app/release", async (_req, res, next) => {
            try {
                const release = await WSServer.getInstance().getLatestReleaseInfo();
                const status = WebAppRelease.getInstance().getStatus();
                res.send({ ok: true, ...release, servedTag: status.tag ?? null, served: status.serving });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Push notifications — the phone's own notification shade            */
        /* ---------------------------------------------------------------- */

        /**
         * A phone registers the push token it got from Expo. Called on every app
         * start, so a reinstall or a re-login refreshes the record instead of
         * leaving a dead token behind (see PushService.registerDevice).
         */
        this.app.post("/api/push/register", this.authorizeClient, async (req, res, next) => {
            try {
                const out = await PushService.getInstance().registerDevice({
                    token: req.body?.token,
                    platform: req.body?.platform,
                    label: req.body?.label,
                    userId: (req as any).user?.username,
                });
                if (!out.ok) return res.status(400).send({ ok: false, error: out.error, devices: out.devices });
                res.send({ ok: true, devices: out.devices });
            } catch (e) { next(e); }
        });

        /** A phone that stops wanting notifications (or logs out) removes itself. */
        this.app.post("/api/push/unregister", this.authorizeClient, async (req, res, next) => {
            try {
                const token = String(req.body?.token ?? "");
                const out = await PushService.getInstance().removeDevice(token);
                res.send({ ok: out.ok, devices: out.devices });
            } catch (e) { next(e); }
        });

        /** Status for Settings: how many phones, what was sent, what failed. */
        this.app.get("/api/push", this.authorizeClient, async (_req, res, next) => {
            try {
                res.send({ ok: true, push: await PushService.getInstance().getPublicStatus() });
            } catch (e) { next(e); }
        });

        /** Settings → “Send test notification”. */
        this.app.post("/api/push/test", this.authorizeClient, async (req, res, next) => {
            try {
                const out = await PushService.getInstance().sendTest(req.body?.text);
                // `ok` comes from the send itself (no devices / disabled are not
                // errors of the request), the status is what Settings shows.
                res.send({ ...out, push: await PushService.getInstance().getStatus() });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Image upload — robot's AI camera capture + analysis                */
        /* ---------------------------------------------------------------- */

        this.app.post("/api/images/upload", upload.single("file"), async (req, res, next) => {
            try {
                if (!this.isDeviceAuthorized(req)) return res.status(401).send({ ok: false, message: "Invalid device token" });
                const file = req.file;
                if (!file) return res.status(400).send({ ok: false, message: "Missing multipart file field 'file'" });
                if (!["image/jpg", "image/png", "image/jpeg"].includes(file.mimetype)) return res.status(415).send({ ok: false, message: "Only PNG/JPEG images are supported" });

                const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
                const activeMission = await this.db.getSetting<any>("activeMission", null);
                const manualPatrol = await this.db.getSetting<any>("manualPatrol", null);
                const scanPoint = Number(req.body.scanPoint || 0);
                const side = ["left", "right", "manual"].includes(req.body.side) ? req.body.side : "manual";
                const manualContext = manualPatrol;
                const missionId = String(manualContext?.missionId || req.body.missionId || activeMission?.missionId || "manual");
                const patrolId = Number(manualContext?.patrolId || req.body.patrolId || activeMission?.patrolId || 0);
                const missionWaypoint = activeMission?.missionId === missionId
                    ? activeMission.waypoints?.find((w: any) => Number(w.index) === scanPoint) : null;
                // Mission metadata is authoritative at autonomous scan stops, then explicit block/GPS fallbacks.
                let block = map?.blocks.find((b) => b.id === manualContext?.blockId) ??
                    map?.blocks.find((b) => b.id === missionWaypoint?.blockId) ??
                    map?.blocks.find((b) => b.id === req.body.blockId) ?? null;
                const lat = Number(req.body.latitude); const lng = Number(req.body.longitude);
                if (!block && Number.isFinite(lat) && Number.isFinite(lng)) block = blockAt(map, lat, lng);
                if (!block) {
                    const trail = await this.db.getRecentTrail(1);
                    if (trail[0]) block = blockAt(map, trail[0].latitude, trail[0].longitude);
                }

                // Map is authoritative. Request plant is only a compatibility fallback.
                const requestedPlant = String(block?.plant || req.body.plant || "").toLowerCase();
                const aliases: Record<string, string> = { chili: "chilli" };
                const plant = aliases[requestedPlant] ?? requestedPlant;
                if (!plant) {
                    // Manual capture outside every mapped crop block: never reject the
                    // operator's photo. Store it and notify clients; AI analysis is
                    // skipped because no crop model applies to an unmapped location.
                    if (side === "manual" || missionId === "manual") {
                        const uploadDir = path.resolve(process.env.UPLOAD_DIR || "data/uploads", missionId);
                        await fs.mkdir(uploadDir, { recursive: true });
                        const imagePath = path.join(uploadDir, `unmapped-${scanPoint}-${side}-${Date.now()}.jpg`);
                        await fs.writeFile(imagePath, file.buffer);
                        const scan = { plant: "unknown", blockId: null, blockName: null,
                            missionId, patrolId, scanPoint, side, imagePath, predictions: [],
                            capturedAt: Date.now(), deviceId: req.body.deviceId || "robot-01" };
                        WSServer.getInstance().io.to("authorized_room").emit("message.upsert", { Type: "ai_scan", Message: scan });
                        return res.send({ ok: true, message: "Manual photo stored (outside mapped blocks; AI analysis skipped)",
                            result: [], context: { plant: null, block: null, missionId, scanPoint, side } });
                    }
                    return res.status(422).send({ ok: false, message: "Robot is not inside a mapped crop block" });
                }
                const model = this.models.find((m) => m.plant === plant);
                // Storage is mandatory even when a model is unavailable. The
                // collection remains visible and can be analyzed later after
                // the appropriate model is installed.
                const predictions = model ? await predictPlant(model, file.buffer, 5) : [];
                const uploadDir = path.resolve(process.env.UPLOAD_DIR || "data/uploads", missionId);
                await fs.mkdir(uploadDir, { recursive: true });
                const safeBlock = String(block?.id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
                const imagePath = path.join(uploadDir, `${safeBlock}-${scanPoint}-${side}-${Date.now()}.jpg`);
                await fs.writeFile(imagePath, file.buffer);
                if (patrolId > 0 && block?.id) {
                    await this.db.saveImageScan({ patrolId, missionId, blockId: block.id, plant,
                        scanPoint, side, imagePath, predictions });
                }
                const scan = { plant, blockId: block?.id ?? null, blockName: block?.name ?? null,
                    missionId, patrolId, scanPoint, side, imagePath, predictions,
                    capturedAt: Date.now(), deviceId: req.body.deviceId || "robot-01" };
                WSServer.getInstance().io.to("authorized_room").emit("message.upsert", { Type: "ai_scan", Message: scan });

                // Real, hardware-completable alert: the AI classifier flagged something
                // other than "healthy" above the configured confidence threshold.
                const top = predictions[0];
                if (top && !isHealthyClass(top.className)) {
                    const fleetConfig = await this.db.getSetting<FleetConfig>("fleetConfig", DEFAULT_FLEET_CONFIG);
                    if (top.confidence >= fleetConfig.diseaseAlertThreshold) {
                        await WSServer.getInstance().raiseAlert(
                            top.confidence >= 0.85 ? "critical" : "warning",
                            `Possible ${top.className.replace(/_+/g, " ")} detected`,
                            `${(top.confidence * 100).toFixed(0)}% confidence in ${block?.name ?? "an unmapped block"} (${plant}).`,
                            "ai_scan", 2 * 60_000,
                        );
                    }
                }

                return res.send({ ok: true, message: model ? "Image stored and analyzed" : "Image stored; no matching AI model yet", result: predictions, context: { plant, block, missionId, scanPoint, side } });
            } catch (e) { next(e); }
        });

        this.app.post("/api/robot/command", this.authorizeClient, (req, res) => {
            WSServer.getInstance().io.to("esp_32_room").emit("control_command", { command: req.body });
            res.send({ ok: true });
        });
        this.app.post("/api/pump/command", this.authorizeClient, (req, res) => {
            WSServer.getInstance().io.to("pump_room").emit("control_command", { command: req.body });
            res.send({ ok: true });
        });

        /* ---------------------------------------------------------------- */
        /* WhatsApp service — link / unlink / relink / owner number          */
        /*                                                                   */
        /* These are what the client's Settings → "WhatsApp Service" card    */
        /* calls: pair a fresh account with a pairing code, delete the       */
        /* session, relink a different account, and store the owner number   */
        /* (country code required) that the bot's command gate checks.      */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/whatsapp", this.authorizeClient, async (_req, res, next) => {
            try {
                res.send({ ok: true, ...(await WhatsAppService.getInstance(logger, this.db).getStatus()) });
            } catch (e) { next(e); }
        });

        this.app.post("/api/whatsapp/link", this.authorizeClient, async (req, res, next) => {
            try {
                const number = normalizeWhatsAppNumber(String(req.body?.number ?? ""));
                if (!number) return res.status(400).send({ ok: false, message: "Enter the WhatsApp number with its country code and digits only (example: 94766045156)" });
                const status = await WhatsAppService.getInstance(logger, this.db).link(number);
                res.send({ ok: true, ...status });
            } catch (e) { next(e); }
        });

        this.app.post("/api/whatsapp/relink", this.authorizeClient, async (req, res, next) => {
            try {
                const number = normalizeWhatsAppNumber(String(req.body?.number ?? ""));
                if (!number) return res.status(400).send({ ok: false, message: "Enter the WhatsApp number with its country code and digits only (example: 94766045156)" });
                const status = await WhatsAppService.getInstance(logger, this.db).relink(number);
                res.send({ ok: true, ...status });
            } catch (e) { next(e); }
        });

        this.app.post("/api/whatsapp/enabled", this.authorizeClient, async (req, res, next) => {
            try {
                // The Settings switch: ON reconnects with the saved session, OFF
                // only stops the socket (the session stays on disk for a later ON).
                const status = await WhatsAppService.getInstance(logger, this.db).setEnabled(Boolean(req.body?.enabled));
                res.send({ ok: true, ...status });
            } catch (e) { next(e); }
        });

        this.app.post("/api/whatsapp/unlink", this.authorizeClient, async (_req, res, next) => {
            try {
                const status = await WhatsAppService.getInstance(logger, this.db).unlink();
                res.send({ ok: true, ...status });
            } catch (e) { next(e); }
        });

        this.app.post("/api/whatsapp/owner", this.authorizeClient, async (req, res, next) => {
            try {
                const number = normalizeWhatsAppNumber(String(req.body?.number ?? ""));
                if (!number) return res.status(400).send({ ok: false, message: "Enter the owner number with its country code and digits only (example: 94766045156)" });
                const status = await WhatsAppService.getInstance(logger, this.db).setOwnerNumber(number);
                res.send({ ok: true, ...status });
            } catch (e) { next(e); }
        });

        /* ---- owner number LIST (max 10, saved in the DB, all alerted) ---- */

        this.app.post("/api/whatsapp/owners", this.authorizeClient, async (req, res, next) => {
            try {
                const status = await WhatsAppService.getInstance(logger, this.db)
                    .addOwnerNumber(String(req.body?.number ?? ""));
                res.send({ ok: true, ...status });
            } catch (e: any) {
                res.status(400).send({ ok: false, message: e?.message ?? "Could not add that number" });
            }
        });

        this.app.post("/api/whatsapp/owners/remove", this.authorizeClient, async (req, res, next) => {
            try {
                const status = await WhatsAppService.getInstance(logger, this.db)
                    .removeOwnerNumber(String(req.body?.number ?? ""));
                res.send({ ok: true, ...status });
            } catch (e: any) {
                res.status(400).send({ ok: false, message: e?.message ?? "Could not remove that number" });
            }
        });

        this.app.post("/api/whatsapp/owners/set", this.authorizeClient, async (req, res, next) => {
            try {
                const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers.map(String) : [];
                const status = await WhatsAppService.getInstance(logger, this.db).setOwnerNumbers(numbers);
                res.send({ ok: true, ...status });
            } catch (e: any) {
                res.status(400).send({ ok: false, message: e?.message ?? "Could not save the owner numbers" });
            }
        });

        this.app.post("/api/whatsapp/test", this.authorizeClient, async (_req, res, next) => {
            try {
                const status = await WhatsAppService.getInstance(logger, this.db).sendTestMessage();
                res.send({ ok: true, ...status });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Web app (the chrclient web build this server publishes)           */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/webapp", this.authorizeClient, (_req, res) => {
            const status = WebAppRelease.getInstance().getStatus();
            res.send({ ok: true, ...status });
        });

        // Force a re-check against GitHub. ?force=1 also re-downloads the same
        // build (normally an unchanged fingerprint means "no download at all").
        this.app.post("/api/webapp/refresh", this.authorizeClient, async (req, res, next) => {
            try {
                const force = ["1", "true", "yes"].includes(String(req.query.force ?? req.body?.force ?? "").toLowerCase());
                const status = await WebAppRelease.getInstance().check(force);
                res.send({ ok: true, forced: force, ...status });
            } catch (e) { next(e); }
        });

        /* ---------------------------------------------------------------- */
        /* Firmware (OTA)                                                    */
        /*                                                                   */
        /* Upload + trigger are operator actions (session token). The two    */
        /* download routes are for the boards themselves: they carry only    */
        /* their device token, and a rover token may fetch rover images      */
        /* while a pump token may fetch pump images - never the other way    */
        /* around, so one board can never be handed the other's .bin.        */
        /* ---------------------------------------------------------------- */

        this.app.get("/api/firmware", this.authorizeClient, (_req, res) => {
            res.send({ ok: true, ...FirmwareRelease.getInstance().status(), devices: WSServer.getInstance().deviceFirmwareList() });
        });

        this.app.post("/api/firmware", this.authorizeClient, firmwareUpload.single("file"), (req, res, next) => {
            try {
                const file = (req as Request & { file?: Express.Multer.File }).file;
                if (!file?.buffer?.length) return res.status(400).send({ ok: false, message: "attach the compiled firmware as the 'file' field (.bin)" });
                const target = String(req.body?.target || "").trim();
                const version = String(req.body?.version || "").trim();
                if (!target || !version) return res.status(400).send({ ok: false, message: "target and version are required" });
                const build = FirmwareRelease.getInstance().saveBuild({
                    target, version, data: file.buffer,
                    notes: String(req.body?.notes || ""),
                    uploadedBy: "operator",
                });
                logger.info({ target, version, size: build.size, md5: build.md5 }, "[OTA] firmware uploaded");
                res.send({ ok: true, build: { ...build, file: undefined } });
            } catch (e) { next(e); }
        });

        this.app.post("/api/firmware/update", this.authorizeClient, async (req, res, next) => {
            try {
                const firmware = FirmwareRelease.getInstance();
                const wss = WSServer.getInstance();
                const requestedTarget = String(req.body?.target || "").trim();
                const requestedVersion = String(req.body?.version || "").trim();
                if (!requestedTarget) return res.status(400).send({ ok: false, message: "target is required ('*' updates every board to the newest image of its own target)" });

                // "*" = one button for the whole fleet: every board gets the newest
                // image of ITS OWN target (never another board's build).
                if (requestedTarget === "*") {
                    const results = firmware.targets().map((target) => {
                        const build = requestedVersion ? firmware.get(target, requestedVersion) : firmware.latest(target);
                        if (!build) return { target, skipped: "no firmware uploaded for this target" };
                        firmware.markPending(target, build.version, "operator");
                        return { target, version: build.version, ...wss.sendOtaCommand(target, build) };
                    });
                    return res.send({ ok: true, results, devices: wss.deviceFirmwareList() });
                }

                const build = requestedVersion ? firmware.get(requestedTarget, requestedVersion) : firmware.latest(requestedTarget);
                if (!build) {
                    return res.status(404).send({
                        ok: false,
                        message: requestedVersion
                            ? `no ${requestedVersion} image for '${requestedTarget}' — upload it first`
                            : `no firmware uploaded for '${requestedTarget}' yet`,
                    });
                }
                // Queue first: a board that is offline right now still gets it on
                // the next device_hello, which is the whole point of the queue.
                firmware.markPending(requestedTarget, build.version, "operator");
                const result = wss.sendOtaCommand(requestedTarget, build);
                logger.info({ target: requestedTarget, version: build.version, ...result }, "[OTA] operator triggered an update");
                res.send({ ok: true, target: requestedTarget, version: build.version, md5: build.md5, size: build.size, ...result, devices: wss.deviceFirmwareList() });
            } catch (e) { next(e); }
        });

        this.app.delete("/api/firmware/:target/:version", this.authorizeClient, (req, res, next) => {
            try {
                const removed = FirmwareRelease.getInstance().removeBuild(String(req.params.target), String(req.params.version));
                if (!removed) return res.status(404).send({ ok: false, message: "no such image" });
                res.send({ ok: true, ...FirmwareRelease.getInstance().status() });
            } catch (e) { next(e); }
        });

        /* -- board-facing: "what is the newest image for me, and give it to me" -- */

        this.app.get("/api/firmware/:target/latest", (req, res, next) => {
            try {
                const target = String(req.params.target);
                const refused = this.refuseFirmwareAccess(target, req);
                if (refused) return res.status(401).send({ ok: false, message: refused });
                const build = FirmwareRelease.getInstance().latest(target);
                if (!build) return res.status(404).send({ ok: false, message: `no firmware uploaded for '${target}'` });
                res.send({
                    ok: true, target, version: build.version, md5: build.md5, sha256: build.sha256,
                    size: build.size, path: firmwarePath(target, build.version),
                    uploadedAt: build.uploadedAt, notes: build.notes,
                });
            } catch (e) { next(e); }
        });

        this.app.get("/api/firmware/:target/bin/:version", async (req, res, next) => {
            try {
                const target = String(req.params.target);
                const version = String(req.params.version);
                const refused = this.refuseFirmwareAccess(target, req);
                if (refused) return res.status(401).send({ ok: false, message: refused });
                const build = FirmwareRelease.getInstance().get(target, version);
                if (!build) return res.status(404).send({ ok: false, message: "unknown firmware image" });
                const data = await fs.readFile(build.file);
                logger.info({ target, version, bytes: data.length, device: req.headers["x-device-token"] ? "device" : "operator" }, "[OTA] firmware downloaded");
                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader("Content-Length", String(data.length));
                res.setHeader("Content-Disposition", `attachment; filename="${build.name}"`);
                res.setHeader("X-Firmware-Version", build.version);
                res.setHeader("X-Firmware-MD5", build.md5);
                res.setHeader("X-Firmware-SHA256", build.sha256);
                res.send(data);
            } catch (e) { next(e); }
        });

        /* -- built-in page: upload the .bin + press Update, no app needed -------- */

        this.app.get("/admin/firmware", (_req, res) => {
            res.setHeader("Content-Type", "text/html; charset=utf-8");
            res.send(FIRMWARE_PAGE_HTML);
        });
        this.app.get("/admin", (_req, res) => res.redirect("/admin/firmware"));

        // Serve the published build. Registered LAST, and it only answers paths
        // the API above did not claim, so /api, /auth, /health and /socket.io
        // keep behaving exactly as before.
        WebAppRelease.getInstance().mount(this.app);

        return this;
    }

    private authorizeClient = (req: Request, res: Response, next: NextFunction): void => {
        // CSV export links are opened directly by the OS/browser (Linking.openURL,
        // window.open, a native share sheet, ...) which cannot attach an
        // Authorization header, so those routes also accept the session token as
        // a `?token=` query param. Every other route still requires the header.
        const headerToken = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
        const queryToken = String(req.query.token || "");
        const token = headerToken || queryToken;
        if (sessions.get(token) !== config.ADMIN_USERNAME) { res.status(401).send({ ok: false, message: "Unauthorized" }); return; }
        next();
    };

    /**
     * Who may download a firmware image. Boards authenticate with their device
     * token the same way they do for image uploads; the operator's session token
     * also works (useful to check what a board would get).
     */
    private refuseFirmwareAccess(target: string, req: Request): string | null {
        const token = String(req.headers["x-device-token"] || req.query.token || req.body?.token || "");
        if (sessions.get(token) === config.ADMIN_USERNAME) return null;
        const isRover = Boolean(config.ROBOT_TOKEN) && token === config.ROBOT_TOKEN;
        const isPump = Boolean(config.PUMP_TOKEN) && token === config.PUMP_TOKEN;
        if (isRover && target === "rover") return null;
        if (isPump && target.startsWith("pump")) return null;
        if (isRover || isPump) return `this token may not download images for '${target}'`;
        return "a valid device token (X-Device-Token) or operator session is required";
    }

    private isDeviceAuthorized(req: Request): boolean {
        const token = String(req.headers["x-device-token"] || req.body?.token || "");
        return Boolean(config.ROBOT_TOKEN) && token === config.ROBOT_TOKEN;
    }

    configureErrorHandling(): this {
        this.app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
            logger.error({ err }, "Unhandled request error");
            res.status(500).send({ ok: false, error: "Internal Server Error", message: process.env.NODE_ENV === "production" ? "An unexpected error occurred" : err.message });
        });
        return this;
    }
}
