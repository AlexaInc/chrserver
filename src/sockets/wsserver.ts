import { Server, Socket } from "socket.io";
import http from "http";
import { logger } from "../index";
import { sessions } from "../server";
import { config } from "../config/config";
import { CHRDatabase } from "../../db/Sqlight";

export interface RobotMessage<T = any> { Type: string; Message: T; }
export interface FieldBlock {
    id: string; name: string; plant: string; aiModel?: string; color?: string;
    polygon: [number, number][];
}
export interface FieldMapMessage { name: string; boundary: [number, number][]; blocks: FieldBlock[]; }

const pointInPolygon = (ring: [number, number][], lat: number, lng: number): boolean => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [yi, xi] = ring[i]; const [yj, xj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};

export const blockAt = (map: FieldMapMessage | null, lat: number, lng: number): FieldBlock | null =>
    map?.blocks.find((b) => pointInPolygon(b.polygon, lat, lng)) ?? null;

export class WSServer {
    public io: Server;
    private static instance: WSServer;
    private readonly deviceSockets = new Map<string, string>();

    constructor(httpServer: http.Server, private readonly db: CHRDatabase) {
        WSServer.instance = this;
        this.io = new Server(httpServer, {
            cors: { origin: true, methods: ["GET", "POST"], credentials: true },
            transports: ["polling", "websocket"],
        });
    }

    public setup(): this {
        this.io.use((socket, next) => {
            const role = String(socket.handshake.auth?.role || socket.handshake.query?.role || "");
            const token = String(socket.handshake.auth?.token || socket.handshake.query?.token || "");
            if (role === "authorized") {
                if (sessions.get(token) !== config.ADMIN_USERNAME) return next(new Error("Authentication failed"));
                return next();
            }
            if (role === "esp_32") {
                if (!token || token !== config.ROBOT_TOKEN) return next(new Error("Invalid robot token"));
                return next();
            }
            if (role === "esp_c3_pump") {
                if (!token || token !== config.PUMP_TOKEN) return next(new Error("Invalid pump token"));
                return next();
            }
            return next(new Error("Invalid or missing role"));
        });
        this.io.on("connection", (socket) => void this.handleConnection(socket));
        return this;
    }

    private async handleConnection(socket: Socket): Promise<void> {
        const role = String(socket.handshake.auth?.role || socket.handshake.query?.role);
        const deviceId = String(socket.handshake.auth?.deviceId || socket.handshake.query?.deviceId ||
            (role === "esp_c3_pump" ? "pump-01" : "robot-01"));

        if (role === "authorized") {
            socket.join("authorized_room");
            this.handleAuthorizedClient(socket);
            const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
            if (map) socket.emit("message.upsert", { Type: "map", Message: map });
        } else {
            const room = role === "esp_c3_pump" ? "pump_room" : "esp_32_room";
            socket.join(room);
            socket.data.deviceId = deviceId;
            socket.data.role = role;
            this.deviceSockets.set(deviceId, socket.id);
            this.handleDevice(socket);
            this.io.to("authorized_room").emit("message.upsert", {
                Type: "device", Message: { deviceId, role, online: true, lastSeen: Date.now() },
            });
            if (role === "esp_32") {
                const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
                if (map) socket.emit("control_command", { command: { action: "field_map", data: map } });
            }
        }

        logger.info({ socketId: socket.id, role, deviceId }, "Socket connected");
        socket.on("disconnect", () => {
            if (role !== "authorized") {
                this.deviceSockets.delete(deviceId);
                this.io.to("authorized_room").emit("message.upsert", {
                    Type: "device", Message: { deviceId, role, online: false, lastSeen: Date.now() },
                });
            }
        });
    }

    private handleDevice(socket: Socket): void {
        socket.on("message.upsert", async (raw: RobotMessage) => {
            try {
                const data = typeof raw === "string" ? JSON.parse(raw) : raw;
                if (!data || typeof data.Type !== "string" || typeof data.Message !== "object") return;
                const message = { ...data.Message, deviceId: socket.data.deviceId };
                const envelope = { Type: data.Type, Message: message };

                if (data.Type === "location") {
                    await this.db.saveLocation(message);
                    const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
                    const block = blockAt(map, Number(message.latitude), Number(message.longitude));
                    socket.emit("control_command", {
                        command: {
                            action: "field_context",
                            data: block ? { blockId: block.id, blockName: block.name, plant: block.plant, aiModel: block.aiModel } : null,
                        },
                    });
                } else if (data.Type === "sensors") {
                    await this.db.saveSensorReading({
                        moisture: message.moisture ?? {
                            raw_value: message.soilRaw ?? 0,
                            moisture_percent: message.soilMoisture ?? 0,
                        },
                        temperature: message.temperature,
                        humidity: message.humidity,
                    });
                } else if (data.Type === "ultrasonic") {
                    await this.db.saveUltrasonic(message.distances_cm ?? []);
                }

                this.io.to("authorized_room").emit("message.upsert", envelope);
            } catch (error) {
                logger.error({ error }, "Device message processing failed");
            }
        });
    }

    private handleAuthorizedClient(socket: Socket): void {
        socket.on("control_message", async (data: any, callback?: (result: any) => void) => {
            const ack = (result: any) => typeof callback === "function" && callback(result);
            try {
                if (!data || typeof data.action !== "string") return ack({ success: false, reason: "Invalid command" });

                if (data.action === "save_field_map") {
                    const map = data.data as FieldMapMessage;
                    if (!this.validMap(map)) return ack({ success: false, reason: "Invalid field map" });
                    await this.db.setSetting("fieldMap", map);
                    this.io.emit("message.upsert", { Type: "map", Message: map });
                    this.io.to("esp_32_room").emit("control_command", { command: { action: "field_map", data: map } });
                    return ack({ success: true, message: "Field map saved" });
                }
                if (data.action === "get_field_map") {
                    const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
                    if (map) socket.emit("message.upsert", { Type: "map", Message: map });
                    return ack({ success: true, data: map });
                }
                if (data.action === "register_crop_batch") {
                    const id = await this.db.registerCropBatch(data.data);
                    return ack({ success: true, message: "Crop batch registered", data: { id } });
                }
                if (data.action === "start_patrol") await this.db.startPatrol("Started from client");

                const pumpActions = new Set(["pump_on", "pump_off", "pump_auto", "set_irrigation_threshold", "irrigate_block", "stop_irrigation"]);
                const targetRoom = pumpActions.has(data.action) ? "pump_room" : "esp_32_room";
                const online = (await this.io.in(targetRoom).fetchSockets()).length > 0;
                if (!online) return ack({ success: false, reason: targetRoom === "pump_room" ? "Pump controller offline" : "Robot offline" });

                this.io.to(targetRoom).emit("control_command", { from: socket.id, command: data });
                ack({ success: true, message: `${data.action} forwarded`, data: { target: targetRoom } });
            } catch (error: any) {
                logger.error({ error }, "Control command failed");
                ack({ success: false, reason: error?.message ?? "Command failed" });
            }
        });
    }

    private validMap(map: FieldMapMessage): boolean {
        if (!map || typeof map.name !== "string" || !Array.isArray(map.blocks) || !Array.isArray(map.boundary)) return false;
        return map.blocks.every((b) => b.id && b.name && b.plant && Array.isArray(b.polygon) && b.polygon.length >= 3 &&
            b.polygon.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));
    }

    public static getInstance(): WSServer {
        if (!WSServer.instance) throw new Error("WSServer instance not created yet");
        return WSServer.instance;
    }
}
