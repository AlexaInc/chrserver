import express, { Response, Request, Express, NextFunction } from "express";
import multer from "multer";
import cors from "cors";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { logger } from "./index";
import { config } from "./config/config";
import { WSServer, FieldMapMessage, blockAt } from "./sockets/wsserver";
import { LoadedPlantModel, predictPlant } from "./services/LoadAimodels";
import { CHRDatabase } from "../db/Sqlight";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
export const sessions = new Map<string, string>();

export interface ServerConfig { port: number; domain: string; }

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

        this.app.get("/api/field-map", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, map: await this.db.getSetting<FieldMapMessage | null>("fieldMap", null) }); } catch (e) { next(e); }
        });
        this.app.put("/api/field-map", this.authorizeClient, async (req, res, next) => {
            try {
                await this.db.setSetting("fieldMap", req.body);
                WSServer.getInstance().io.emit("message.upsert", { Type: "map", Message: req.body });
                res.send({ ok: true });
            } catch (e) { next(e); }
        });

        this.app.get("/api/crops", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, crops: await this.db.getCropBatches() }); } catch (e) { next(e); }
        });
        this.app.get("/api/reports", this.authorizeClient, async (_req, res, next) => {
            try { res.send({ ok: true, reports: await this.db.getReports(50) }); } catch (e) { next(e); }
        });

        this.app.post("/api/images/upload", upload.single("file"), async (req, res, next) => {
            try {
                if (!this.isDeviceAuthorized(req)) return res.status(401).send({ ok: false, message: "Invalid device token" });
                const file = req.file;
                if (!file) return res.status(400).send({ ok: false, message: "Missing multipart file field 'file'" });
                if (!["image/jpg", "image/png", "image/jpeg"].includes(file.mimetype)) return res.status(415).send({ ok: false, message: "Only PNG/JPEG images are supported" });

                const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
                const activeMission = await this.db.getSetting<any>("activeMission", null);
                const missionId = String(req.body.missionId || activeMission?.missionId || "manual");
                const patrolId = Number(req.body.patrolId || activeMission?.patrolId || 0);
                const scanPoint = Number(req.body.scanPoint || 0);
                const side = ["left", "right", "manual"].includes(req.body.side) ? req.body.side : "manual";
                const missionWaypoint = activeMission?.missionId === missionId
                    ? activeMission.waypoints?.find((w: any) => Number(w.index) === scanPoint) : null;
                // Mission metadata is authoritative at autonomous scan stops, then explicit block/GPS fallbacks.
                let block = map?.blocks.find((b) => b.id === missionWaypoint?.blockId) ??
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
                if (!plant) return res.status(422).send({ ok: false, message: "Robot is not inside a mapped crop block" });
                const model = this.models.find((m) => m.plant === plant);
                if (!model) return res.status(404).send({ ok: false, message: `No AI model for ${plant}`, available: this.models.map((m) => m.plant) });

                const predictions = await predictPlant(model, file.buffer, 5);
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
                return res.send({ ok: true, message: "Image analyzed", result: predictions, context: { plant, block, missionId, scanPoint, side } });
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
        const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
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
