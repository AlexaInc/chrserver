import express, { Response, Request, Express, NextFunction } from "express";
import multer from "multer";
import cors from "cors";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./index";
import { config } from "./config/config";
import { WSServer, FieldMapMessage, blockAt, FleetConfig, DEFAULT_FLEET_CONFIG } from "./sockets/wsserver";
import { LoadedPlantModel, predictPlant } from "./services/LoadAimodels";
import { CHRDatabase } from "../db/Sqlight";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
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

        this.app.get("/health", (_req, res) => res.send({ ok: true, service: "chrserver", time: Date.now(), models: this.models.map((m) => m.plant) }));

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
            try { res.send({ ok: true, config: await this.db.getSetting<FleetConfig>("fleetConfig", DEFAULT_FLEET_CONFIG) }); } catch (e) { next(e); }
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
                });
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
