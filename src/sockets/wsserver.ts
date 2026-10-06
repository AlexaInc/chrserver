import { Server, Socket } from "socket.io";
import http from "http";
import { logger } from "../logger";
import { sessions } from "../server";
import { config } from "../config/config";
import { CHRDatabase, AlertSeverity } from "../../db/Sqlight";
import { planMission, AutonomousMission } from "../services/MissionPlanner";
import { createHash } from "crypto";

export interface RobotMessage<T = any> { Type: string; Message: T; }
export interface FieldBlock {
    id: string; name: string; plant: string; aiModel?: string; color?: string;
    polygon: [number, number][];
    rowSpacingM?: number;
    scanSpacingM?: number;
    headingDeg?: number;
}
export interface FieldMapMessage {
    name: string; boundary: [number, number][]; blocks: FieldBlock[];
    base?: { latitude: number; longitude: number; name?: string };
    /** Content revision (sha1 prefix) computed by the server. The rover stores
     *  it next to the map on its SD card and reports it back in `device_hello`,
     *  so an unchanged map is never re-transmitted on a reconnect. */
    rev?: string;
}

/** Persisted default parameters set from the Settings screen — every field here maps
 *  to something the backend/robot can actually act on (no fantasy fields). */
export interface FleetConfig {
    rowSpacingM: number;
    scanSpacingM: number;
    arrivalRadiusM: number;
    irrigationThresholdPercent: number;
    /** Minimum top-class confidence (0-1) before an AI scan raises a disease alert. */
    diseaseAlertThreshold: number;
    /** Drive speed as a percentage of the rover's own safe cruise PWM. The
     *  firmware applies it as a LIMIT (100 % == 110 of 255 duty) and
     *  MOTION_HARD_MAX_PWM is a compile-time ceiling nothing can cross, so
     *  this value can only ever make the rover slower - never faster. */
    driveSpeedPercent: number;
    /** In-place turn speed, same scale as driveSpeedPercent. */
    turnSpeedPercent: number;
    /** Mounting angle (degrees, 0-80) of the front-LEFT ultrasonic bracket,
     *  measured from straight ahead. The rover converts every side reading with
     *  this angle, so a re-bolted bracket only needs this number changed — the
     *  firmware steers with the real geometry instead of a hardcoded guess. */
    sensorAngleLeftDeg: number;
    /** Mounting angle of the front-RIGHT bracket, same scale. */
    sensorAngleRightDeg: number;
    /** Steer a held FORWARD command around a plant during manual driving
     *  instead of letting the safety envelope stop the rover at it. */
    avoidAssist: boolean;
}
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
    rowSpacingM: 1, scanSpacingM: 1, arrivalRadiusM: 2,
    irrigationThresholdPercent: 35, diseaseAlertThreshold: 0.6,
    // Fresh installs start deliberately slow: this rover works between closely
    // planted crops, so the operator raises the limit only when they need to.
    driveSpeedPercent: 70, turnSpeedPercent: 65,
    // Bracket angles of the printed front mounts: the two side sensors are
    // splayed outwards, which is what removes the blind spot between the centre
    // beam and each corner. Manual driving gets the avoid assist by default.
    sensorAngleLeftDeg: 45, sensorAngleRightDeg: 45, avoidAssist: true,
};
/** Percentages coming from the app/panel are clamped into a hard 0-100 range. */
export const clampPercent = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
};
/** Sensor bracket angles: 0-80 degrees, rounded to whole degrees. Beyond 80 the
 *  side beam would look almost sideways and stop covering the front corner. */
export const clampAngle = (value: unknown, fallback: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(80, Math.round(n)));
};
/** How long to wait for a `device_hello` before sending the field map anyway.
 *  New firmware announces the revision it holds on SD; older firmware never
 *  does, so it still receives the map - just after this grace period. */
export const MAP_HELLO_GRACE_MS = 2500;

/** Actions the ESP32 rover firmware genuinely understands (see chrhw src/main.cpp). */
const ROVER_ACTIONS = new Set([
    "drive", "stop", "return_to_base", "pause_patrol", "start_patrol",
    "cap_photo", "camera_capture_burst", "autonomous_mission", "field_context",
    // Motion limits + cache introspection implemented by the rover's
    // non-blocking motion engine (see chrhw wokwi-esp32-project).
    "set_speed", "motion_config", "get_motion_status", "get_map_status",
]);
/** Actions the ESP32-C3 pump firmware genuinely understands (see chrhw wokwi-water-pump-c3). */
const PUMP_ACTIONS = new Set([
    "pump_on", "pump_off", "pump_auto", "set_irrigation_threshold", "irrigate_block", "stop_irrigation",
]);
/** Actions the client may still send that no physical hardware in this project supports.
 *  These are rejected here (instead of being silently forwarded into a robot that will just
 *  log "Unknown action command") so the client always gets an honest ack. */
const UNSUPPORTED_ACTIONS = new Set([
    "calibrate_gimbal", "camera_set_channel", "camera_set_zoom", "camera_record",
    "run_predictive_model", "schedule_report", "add_field_boundary", "deploy_waypoint_mission",
]);

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

/** Deterministic JSON (objects sorted by key) so the same map always hashes to
 *  the same revision regardless of property order. */
const stableStringify = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
};

/** Short content hash of a field map. This is the checksum the rover keeps on
 *  its SD card: it sends it in `device_hello`, the server compares it with the
 *  revision of the map it has stored, and only a mismatch is downloaded. */
export const mapRevision = (map: FieldMapMessage): string => {
    const { rev: _ignored, ...content } = map;
    return createHash("sha1").update(stableStringify(content)).digest("hex").slice(0, 12);
};

/** Robot status as observable from real signals only — no fabricated telemetry.
 *  RobotState is intentionally limited to what we can truthfully know:
 *  offline (socket disconnected), patrolling (mission running), idle (no/paused
 *  mission), fault (robot reported a mission fault). There is no IMU/wheel-encoder
 *  speed/heading, no battery gauge, and no autonomous return-to-base path on this
 *  hardware build, so those are never synthesized. */
/** Speed limits: what the operator asked for (fleet config) next to what the
 *  rover reported it is actually using (motion_config message). */
export interface MotionStatus {
    driveSpeedPercent: number;
    turnSpeedPercent: number;
    drivePwm?: number;
    turnPwm?: number;
    appliedPwm?: number;
    cruiseBasePwm?: number;
    turnBasePwm?: number;
    hardMaxPwm?: number;
    intent?: string;
    source?: string;
    blockedBy?: string;
    obstacleStopCm?: number;
    /** Absolute emergency line of the front-arc planner (cm). */
    emergencyStopCm?: number;
    driveFailsafeMs?: number;
    /** Front-arc geometry the rover is actually using (panel-adjustable). */
    sensorAngleLeftDeg?: number;
    sensorAngleRightDeg?: number;
    avoidAssist?: boolean;
    /** What the arc planner is doing right now: clear, steer-left, steer-right,
     *  creep (driving past a plant at crawl speed), turn-back, no-path,
     *  emergency. This is how the dashboard shows that the rover is going
     *  around a plant instead of stopping at it. */
    avoidState?: string;
    /** -1 = steering left, +1 = steering right, 0 = straight/blocked. */
    avoidDir?: number;
    /** Lateral room the left/right beams prove (cm) - the passable width. */
    gapLeftCm?: number;
    gapRightCm?: number;
    /** Centre distance the manoeuvre was decided on (cm). */
    frontCm?: number;
    reportedAt?: number;
}

/** Field-map cache state: the server's revision vs the revision the rover
 *  reported from its SD card in `device_hello` / `map_status`. */
export interface FieldMapSyncStatus {
    serverRev?: string;
    robotRev?: string;
    inSync: boolean;
    blocks?: number;
    bytes?: number;
    sd?: boolean;
    lastSaveReason?: string;
    updatedAt?: number;
}

/** What a device announced when it connected (device_hello). */
export interface DeviceHello {
    deviceId: string;
    role?: string;
    firmware?: string;
    mapRev?: string;
    mapBlocks?: number;
    mapBytes?: number;
    sd?: boolean;
    driveSpeedPercent?: number;
    turnSpeedPercent?: number;
    at: number;
}

export interface RobotStatus {
    state: "offline" | "patrolling" | "idle" | "fault";
    mode: "autonomous" | "manual";
    missionId?: string;
    currentWaypoint?: number;
    totalWaypoints?: number;
    progress?: number;
    message?: string;
    motion?: MotionStatus;
    fieldMap?: FieldMapSyncStatus;
}

/** Reply shape shared by the socket ack and the REST/WhatsApp callers. */
export interface CommandAck {
    success: boolean;
    message?: string;
    reason?: string;
    data?: unknown;
}

export class WSServer {
    public io: Server;
    private static instance: WSServer;
    private readonly deviceSockets = new Map<string, string>();
    private readonly onlineRoles = new Set<string>(); // "esp_32" | "esp_c3_pump"
    /** Last operator mode INTENT (change_mode/manual_teleop). Reporting the
     *  live mode to clients never trusts this flag alone — computeStatus()
     *  derives the mode from what the rover is verifiably doing, because the
     *  firmware boots in manual (no mission loaded) regardless of this value. */
    private robotMode: "autonomous" | "manual" = "manual";
    private lastMission: { missionId?: string; state?: string; currentWaypoint?: number; totalWaypoints?: number; progress?: number; message?: string } = {};
    private readonly alertThrottle = new Map<string, number>();
    /** Field-map revision each device reported holding on its SD card. */
    private readonly deviceMapRev = new Map<string, string>();
    /** Last device_hello per device (firmware build, SD availability, speeds). */
    private readonly deviceHello = new Map<string, DeviceHello>();
    /** Last motion_config / map_status the rover reported. */
    private robotMotion: (MotionStatus & { at: number }) | null = null;
    private robotMapStatus: { rev?: string; blocks?: number; bytes?: number; sd?: boolean; reason?: string; at: number } | null = null;
    /** Timer that sends the field map when a device never announces a revision. */
    private readonly pendingMapTimers = new Map<string, NodeJS.Timeout>();

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

    /** Send missions in bounded Socket.IO events. The ESP32 WebSockets
     *  library rejects frames above 15 KB; a 216-waypoint mission is ~35 KB.
     *  Chunks of 32 waypoints stay comfortably below that limit. */
    private emitMissionChunks(
        emit: (event: string, payload: unknown) => unknown,
        mission: AutonomousMission,
        startPaused: boolean,
        from?: string,
    ): void {
        const { waypoints, ...metadata } = mission;
        emit("control_command", {
            ...(from ? { from } : {}),
            command: {
                action: "autonomous_mission_begin",
                data: { ...metadata, totalWaypoints: waypoints.length, startPaused },
                timestamp: Date.now(),
            },
        });
        const chunkSize = 32;
        for (let offset = 0; offset < waypoints.length; offset += chunkSize) {
            emit("control_command", {
                ...(from ? { from } : {}),
                command: {
                    action: "autonomous_mission_chunk",
                    data: { missionId: mission.missionId, offset, waypoints: waypoints.slice(offset, offset + chunkSize) },
                },
            });
        }
        emit("control_command", {
            ...(from ? { from } : {}),
            command: {
                action: "autonomous_mission_end",
                data: { missionId: mission.missionId, totalWaypoints: waypoints.length, startPaused },
            },
        });
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
            socket.emit("message.upsert", { Type: "status", Message: await this.computeStatus() });
        } else {
            const room = role === "esp_c3_pump" ? "pump_room" : "esp_32_room";
            socket.join(room);
            socket.data.deviceId = deviceId;
            socket.data.role = role;
            this.deviceSockets.set(deviceId, socket.id);
            this.onlineRoles.add(role);
            this.handleDevice(socket);
            this.io.to("authorized_room").emit("message.upsert", {
                Type: "device", Message: { deviceId, role, online: true, lastSeen: Date.now() },
            });
            if (role === "esp_32") {
                // Field map: the rover reports the revision of the map it already
                // holds on its SD card in a `device_hello` event. Sending the map
                // only when that revision actually differs is what stops the rover
                // re-downloading the same map on every single reconnect.
                this.scheduleFieldMap(socket, deviceId);
                // Push the operator's speed limits as well: the rover keeps its
                // own copy on SD, but the panel stays the source of truth.
                const fleet = await this.getFleetConfig();
                socket.emit("control_command", {
                    command: {
                        action: "motion_config",
                        data: {
                            driveSpeedPercent: fleet.driveSpeedPercent,
                            turnSpeedPercent: fleet.turnSpeedPercent,
                            sensorAngleLeftDeg: fleet.sensorAngleLeftDeg,
                            sensorAngleRightDeg: fleet.sensorAngleRightDeg,
                            avoidAssist: fleet.avoidAssist,
                        },
                        timestamp: Date.now(),
                    },
                });
                // A (re)booted rover has lost any in-flight mission from RAM. If the
                // DB still holds one, reload it onto the robot in a PAUSED state:
                // the dashboard then truthfully shows idle/manual and the operator's
                // "Resume Patrol" / autonomous-mode buttons genuinely work again.
                const active = await this.db.getSetting<AutonomousMission | null>("activeMission", null);
                if (active && this.lastMission.state !== "completed") {
                    this.emitMissionChunks((event, payload) => socket.emit(event, payload), active, true);
                    socket.emit("control_command", { command: { action: "pause_patrol" } });
                    this.lastMission = {
                        missionId: active.missionId, state: "paused", currentWaypoint: 0,
                        totalWaypoints: active.waypoints.length, progress: 0,
                        message: "Mission reloaded after robot restart — paused, resume when ready",
                    };
                    this.robotMode = "manual";
                }
                await this.broadcastStatus();
            }
        }

        logger.info({ socketId: socket.id, role, deviceId }, "Socket connected");
        socket.on("disconnect", (reason) => {
            logger.warn({ socketId: socket.id, role, deviceId, reason }, "Socket disconnected");
            const pendingMap = this.pendingMapTimers.get(deviceId);
            if (pendingMap) {
                clearTimeout(pendingMap);
                this.pendingMapTimers.delete(deviceId);
            }
            if (role !== "authorized") {
                if (this.deviceSockets.get(deviceId) === socket.id) {
                    this.deviceSockets.delete(deviceId);
                    // Only drop the role when no OTHER socket still holds it: a
                    // second device of the same role (e.g. a spare/legacy rover
                    // disconnecting) must not report the whole role as offline.
                    const roleStillHeld = [...this.io.sockets.sockets.values()]
                        .some((s) => s.id !== socket.id && String(s.data.role || "") === role);
                    if (!roleStillHeld) this.onlineRoles.delete(role);
                }
                this.io.to("authorized_room").emit("message.upsert", {
                    Type: "device", Message: { deviceId, role, online: false, lastSeen: Date.now() },
                });
                const label = role === "esp_c3_pump" ? "Pump controller" : "Robot";
                void this.raiseAlert("warning", `${label} went offline`,
                    `${deviceId} disconnected from the server.`, role || "system", 60_000);
                if (role === "esp_32") void this.broadcastStatus();
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Status — synthesized only from real, observable facts               */
    /* ------------------------------------------------------------------ */

    public isRobotOnline(): boolean {
        return this.onlineRoles.has("esp_32");
    }

    public isPumpOnline(): boolean {
        return this.onlineRoles.has("esp_c3_pump");
    }

    /** Mode is DERIVED, mirroring the firmware exactly: the rover is
     *  "autonomous" only while a mission is loaded and actively running
     *  (autonomousActive && !autonomousPaused on the ESP32); in every other
     *  situation — fresh boot, no mission, paused, fault, offline — it is
     *  driven manually. This keeps every screen consistent and survives
     *  client re-login and server restarts. */
    public async computeStatus(): Promise<RobotStatus> {
        const [motion, fieldMap] = await Promise.all([this.motionStatus(), this.fieldMapSyncStatus()]);
        if (!this.isRobotOnline()) return { state: "offline", mode: "manual", motion, fieldMap };
        const active = await this.db.getSetting<AutonomousMission | null>("activeMission", null);
        if (this.lastMission.state === "fault") {
            return { state: "fault", mode: "manual", message: this.lastMission.message, missionId: this.lastMission.missionId, motion, fieldMap };
        }
        if (active && this.lastMission.state !== "completed") {
            const running = this.lastMission.state !== "paused";
            return {
                state: running ? "patrolling" : "idle",
                mode: running ? "autonomous" : "manual",
                missionId: this.lastMission.missionId ?? active.missionId,
                currentWaypoint: this.lastMission.currentWaypoint,
                totalWaypoints: this.lastMission.totalWaypoints ?? active.waypoints.length,
                progress: this.lastMission.progress,
                message: this.lastMission.message,
                motion, fieldMap,
            };
        }
        return { state: "idle", mode: "manual", message: this.lastMission.message, motion, fieldMap };
    }

    /** Operator's speed limits next to what the rover reported using. */
    public async motionStatus(): Promise<MotionStatus> {
        const fleet = await this.getFleetConfig();
        const robot = this.robotMotion;
        return {
            driveSpeedPercent: robot?.driveSpeedPercent ?? fleet.driveSpeedPercent,
            turnSpeedPercent: robot?.turnSpeedPercent ?? fleet.turnSpeedPercent,
            drivePwm: robot?.drivePwm,
            turnPwm: robot?.turnPwm,
            appliedPwm: robot?.appliedPwm,
            cruiseBasePwm: robot?.cruiseBasePwm,
            turnBasePwm: robot?.turnBasePwm,
            hardMaxPwm: robot?.hardMaxPwm,
            intent: robot?.intent,
            source: robot?.source,
            blockedBy: robot?.blockedBy,
            obstacleStopCm: robot?.obstacleStopCm,
            emergencyStopCm: robot?.emergencyStopCm,
            driveFailsafeMs: robot?.driveFailsafeMs,
            sensorAngleLeftDeg: robot?.sensorAngleLeftDeg,
            sensorAngleRightDeg: robot?.sensorAngleRightDeg,
            avoidAssist: robot?.avoidAssist,
            avoidState: robot?.avoidState,
            avoidDir: robot?.avoidDir,
            gapLeftCm: robot?.gapLeftCm,
            gapRightCm: robot?.gapRightCm,
            frontCm: robot?.frontCm,
            reportedAt: robot?.at,
        };
    }

    /** The server's map revision vs the revision the rover reported from SD. */
    public async fieldMapSyncStatus(): Promise<FieldMapSyncStatus> {
        const entry = await this.getFieldMapWithRev();
        const robotId = this.latestRobotId();
        const hello = this.deviceHello.get(robotId);
        const robotRev = this.deviceMapRev.get(robotId) ?? this.robotMapStatus?.rev;
        return {
            serverRev: entry?.rev,
            robotRev,
            inSync: Boolean(entry?.rev) && robotRev === entry?.rev,
            blocks: entry?.map.blocks.length ?? this.robotMapStatus?.blocks,
            bytes: this.robotMapStatus?.bytes,
            sd: this.robotMapStatus?.sd ?? hello?.sd,
            lastSaveReason: this.robotMapStatus?.reason,
            updatedAt: this.robotMapStatus?.at ?? hello?.at,
        };
    }

    /** Device id of the connected rover (falls back to the first esp_32 socket). */
    private latestRobotId(): string {
        for (const [id, hello] of this.deviceHello) {
            if (hello.role !== "esp_c3_pump") return id;
        }
        const first = [...this.deviceSockets.keys()][0];
        return first ?? "robot-01";
    }

    private async broadcastStatus(): Promise<void> {
        this.io.to("authorized_room").emit("message.upsert", { Type: "status", Message: await this.computeStatus() });
    }

    /* ------------------------------------------------------------------ */
    /* Command entry points                                                */
    /*                                                                     */
    /* The dashboard socket handler below and the WhatsApp service both    */
    /* end up here, so a command typed in WhatsApp goes through exactly    */
    /* the same checks, bookkeeping and audit trail as a button pressed    */
    /* in the app (robot online? field map saved? waypoint limit?).        */
    /* ------------------------------------------------------------------ */

    /** The saved field map with its revision, or null when the operator has not
     *  mapped the field yet. The revision is the checksum the rover keeps on SD. */
    public async getFieldMapWithRev(): Promise<{ map: FieldMapMessage; rev: string } | null> {
        const map = await this.db.getSetting<FieldMapMessage | null>("fieldMap", null);
        if (!map) return null;
        const rev = map.rev ?? mapRevision(map);
        if (map.rev !== rev) await this.db.setSetting("fieldMap", { ...map, rev }); // backfill older saves
        return { map: { ...map, rev }, rev };
    }

    /** The saved field map, or null when the operator has not mapped yet. */
    public async getFieldMap(): Promise<FieldMapMessage | null> {
        const entry = await this.getFieldMapWithRev();
        return entry ? entry.map : null;
    }

    /** The persisted fleet defaults (spacing / thresholds / speed limits), always
     *  complete: records written before the speed limits existed fall back to the
     *  safe defaults instead of yielding undefined. */
    public async getFleetConfig(): Promise<FleetConfig> {
        const stored = await this.db.getSetting<Partial<FleetConfig>>("fleetConfig", {});
        return {
            ...DEFAULT_FLEET_CONFIG,
            ...stored,
            driveSpeedPercent: clampPercent(stored.driveSpeedPercent, DEFAULT_FLEET_CONFIG.driveSpeedPercent),
            turnSpeedPercent: clampPercent(stored.turnSpeedPercent, DEFAULT_FLEET_CONFIG.turnSpeedPercent),
            // Front-arc geometry: an untouched install gets the printed bracket
            // angles, and nothing outside 0-80 deg ever reaches the rover.
            sensorAngleLeftDeg: clampAngle(stored.sensorAngleLeftDeg, DEFAULT_FLEET_CONFIG.sensorAngleLeftDeg),
            sensorAngleRightDeg: clampAngle(stored.sensorAngleRightDeg, DEFAULT_FLEET_CONFIG.sensorAngleRightDeg),
            avoidAssist: stored.avoidAssist === undefined ? DEFAULT_FLEET_CONFIG.avoidAssist : stored.avoidAssist !== false,
        };
    }

    /** Store new speed limits and push them to the rover. Values are clamped to
     *  0-100 %, and the firmware clamps them once more against its own ceiling —
     *  a bad panel value can never make the rover run away. */
    public async setMotionConfig(input: {
        driveSpeedPercent?: number; turnSpeedPercent?: number;
        sensorAngleLeftDeg?: number; sensorAngleRightDeg?: number; avoidAssist?: boolean;
    }, from?: string): Promise<CommandAck> {
        const fleet = await this.getFleetConfig();
        const drive = clampPercent(input.driveSpeedPercent, fleet.driveSpeedPercent);
        const turn = clampPercent(input.turnSpeedPercent, fleet.turnSpeedPercent);
        // The front-arc angles are how the rover knows where its side beams
        // point; changing them is how the operator matches a re-bolted bracket.
        const angleLeft = clampAngle(input.sensorAngleLeftDeg, fleet.sensorAngleLeftDeg);
        const angleRight = clampAngle(input.sensorAngleRightDeg, fleet.sensorAngleRightDeg);
        const avoidAssist = input.avoidAssist === undefined ? fleet.avoidAssist : input.avoidAssist !== false;
        const merged: FleetConfig = {
            ...fleet,
            driveSpeedPercent: drive, turnSpeedPercent: turn,
            sensorAngleLeftDeg: angleLeft, sensorAngleRightDeg: angleRight, avoidAssist,
        };
        await this.db.setSetting("fleetConfig", merged);
        if (!this.isRobotOnline()) {
            return { success: false, reason: "Robot offline - limit saved and applied when it reconnects", data: merged };
        }
        this.emitMotionConfig(merged, from);
        return {
            success: true,
            message: `Rover limits: ${drive} % drive / ${turn} % turn · side sensors ±${angleLeft}°/±${angleRight}° · assist ${avoidAssist ? "on" : "off"}`,
            data: merged,
        };
    }

    /** Send the stored speed limits to the rover (firmware action motion_config). */
    private emitMotionConfig(fleet: FleetConfig, from?: string): void {
        this.io.to("esp_32_room").emit("control_command", {
            ...(from ? { from } : {}),
            command: {
                action: "motion_config",
                data: {
                    driveSpeedPercent: fleet.driveSpeedPercent,
                    turnSpeedPercent: fleet.turnSpeedPercent,
                    sensorAngleLeftDeg: fleet.sensorAngleLeftDeg,
                    sensorAngleRightDeg: fleet.sensorAngleRightDeg,
                    avoidAssist: fleet.avoidAssist,
                },
                timestamp: Date.now(),
            },
        });
    }

    /** Send the field map once we know whether this rover still needs it. */
    private scheduleFieldMap(socket: Socket, deviceId: string): void {
        const existing = this.pendingMapTimers.get(deviceId);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
            this.pendingMapTimers.delete(deviceId);
            void this.sendFieldMapIfNeeded(socket, deviceId);
        }, MAP_HELLO_GRACE_MS);
        this.pendingMapTimers.set(deviceId, timer);
    }

    /** Transmit the field map ONLY when the rover does not already hold it.
     *  `reportedRev` is the revision the rover says it cached on its SD card; an
     *  empty/absent value means it has nothing cached (or is old firmware). */
    private async sendFieldMapIfNeeded(socket: Socket, deviceId: string, reportedRev?: string): Promise<void> {
        const entry = await this.getFieldMapWithRev();
        if (!entry) {
            logger.info({ deviceId }, "No field map stored yet - rover keeps its SD copy");
            return;
        }
        if (reportedRev && reportedRev === entry.rev) {
            this.deviceMapRev.set(deviceId, reportedRev);
            logger.info({ deviceId, rev: entry.rev }, "Rover already holds this field map on SD - not re-sending");
            await this.broadcastStatus();
            return;
        }
        socket.emit("control_command", {
            command: { action: "field_map", data: { ...entry.map, rev: entry.rev }, timestamp: Date.now() },
        });
        this.deviceMapRev.delete(deviceId); // unknown until the rover confirms
        logger.info({ deviceId, rev: entry.rev, reportedRev: reportedRev ?? null }, "Field map sent to rover");
    }

    /** Deploy (or re-deploy) an autonomous mission — same path as the app's
     *  `deploy_mission` action: plan route → persist activeMission → stream the
     *  chunks to the rover → broadcast state to every authorized client. */
    public async deployMission(data: {
        blocks?: string[]; rowSpacingM?: number; scanSpacingM?: number;
        arrivalRadiusM?: number; headingDeg?: number;
    } = {}, from?: string): Promise<CommandAck> {
        try {
            if (!this.isRobotOnline()) return { success: false, reason: "Robot offline" };
            const map = await this.getFieldMap();
            if (!map) return { success: false, reason: "Create and save a field map first" };
            const fleetConfig = await this.getFleetConfig();
            const requested = Array.isArray(data.blocks) && data.blocks.length ? data.blocks : [];
            const blockIds = requested.length ? requested : map.blocks.map((b) => b.id);
            const unknown = requested.filter((id) => !map.blocks.some((b) => b.id === id));
            if (unknown.length) return { success: false, reason: `Unknown block(s): ${unknown.join(", ")}` };
            const patrolId = await this.db.startPatrol(`Mission blocks: ${blockIds.join(",")}`);
            const mission = planMission(map, blockIds, { ...fleetConfig, ...data }, patrolId);
            if (mission.waypoints.length > 512) {
                await this.db.completePatrol(patrolId);
                return { success: false, reason: `Route has ${mission.waypoints.length} waypoints; increase row/photo spacing (device maximum: 512)` };
            }
            await this.db.setSetting("activeMission", mission);
            this.lastMission = { missionId: mission.missionId, state: "running", currentWaypoint: 0, totalWaypoints: mission.waypoints.length, progress: 0 };
            this.robotMode = "autonomous";
            this.emitMissionChunks(
                (event, payload) => this.io.to("esp_32_room").emit(event, payload),
                mission,
                false,
                from,
            );
            this.io.to("authorized_room").emit("message.upsert", {
                Type: "mission", Message: { ...mission, state: "deployed", currentWaypoint: 0 },
            });
            await this.broadcastStatus();
            return { success: true, message: `Mission deployed: ${mission.waypoints.length} waypoints (${blockIds.length} block(s))`, data: mission };
        } catch (error: any) {
            return { success: false, reason: error?.message ?? "Mission planning failed" };
        }
    }

    /** Switch the rover between autonomous patrol and manual driving. On this
     *  firmware "manual" == autonomous patrol paused (see the mode comment above). */
    public async setRobotMode(mode: "autonomous" | "manual", from?: string): Promise<CommandAck> {
        if (!this.isRobotOnline()) return { success: false, reason: "Robot offline" };
        const emit = (action: string) => this.io.to("esp_32_room").emit("control_command", {
            ...(from ? { from } : {}),
            command: { action, timestamp: Date.now() },
        });
        if (mode === "manual") {
            this.robotMode = "manual";
            emit("pause_patrol");
            await this.broadcastStatus();
            return { success: true, message: "Manual control enabled (autonomous patrol paused)" };
        }
        const active = await this.db.getSetting<AutonomousMission | null>("activeMission", null);
        if (!active) return { success: false, reason: "No mission loaded to resume" };
        this.robotMode = "autonomous";
        emit("start_patrol");
        await this.broadcastStatus();
        return { success: true, message: "Autonomous patrol resumed" };
    }

    /** Forward one of the actions the ESP32 rover firmware really understands. */
    public async controlRobot(action: string, data?: unknown, from?: string): Promise<CommandAck> {
        if (!ROVER_ACTIONS.has(action)) return { success: false, reason: `Unknown action "${action}"` };
        if (!this.isRobotOnline()) return { success: false, reason: "Robot offline" };
        this.io.to("esp_32_room").emit("control_command", {
            ...(from ? { from } : {}),
            command: { action, ...(data !== undefined ? { data } : {}), timestamp: Date.now() },
        });
        return { success: true, message: `${action} forwarded`, data: { target: "esp_32_room" } };
    }

    /** Forward one of the ESP32-C3 pump controller actions. */
    public async controlPump(action: string, data?: unknown, from?: string): Promise<CommandAck> {
        if (!PUMP_ACTIONS.has(action)) return { success: false, reason: `Unknown action "${action}"` };
        if (!this.isPumpOnline()) return { success: false, reason: "Pump controller offline" };
        this.io.to("pump_room").emit("control_command", {
            ...(from ? { from } : {}),
            command: { action, ...(data !== undefined ? { data } : {}), timestamp: Date.now() },
        });
        return { success: true, message: `${action} forwarded`, data: { target: "pump_room" } };
    }

    /* ------------------------------------------------------------------ */
    /* Alerts — only for real, observable conditions                       */
    /* ------------------------------------------------------------------ */

    /** Creates + broadcasts an alert. `throttleMs` (optional) drops duplicate
     *  titles raised again within that window, so noisy sensors (rain, low
     *  soil moisture) don't spam the Alerts screen. */
    public async raiseAlert(severity: AlertSeverity, title: string, description: string, source: string, throttleMs = 0): Promise<void> {
        const key = `${source}:${title}`;
        const last = this.alertThrottle.get(key) ?? 0;
        if (throttleMs > 0 && Date.now() - last < throttleMs) return;
        this.alertThrottle.set(key, Date.now());
        const row = await this.db.createAlert({ severity, title, description, source });
        this.io.to("authorized_room").emit("message.upsert", {
            Type: "alert",
            Message: { id: row.id, severity: row.severity, title: row.title, description: row.description ?? undefined, timestamp: row.created_at },
        });
    }

    /* ------------------------------------------------------------------ */
    /* Device (esp_32 / esp_c3_pump) → server                              */
    /* ------------------------------------------------------------------ */

    private handleDevice(socket: Socket): void {
        /* ------------------------------------------------------------------ */
        /* Handshake: device_hello                                             */
        /*                                                                     */
        /* The rover announces the field-map revision it holds on its SD card  */
        /* (plus firmware build, SD availability and the speed limits it       */
        /* restored) right after connecting. A matching revision means the     */
        /* field_map payload is NOT sent at all.                               */
        /* ------------------------------------------------------------------ */
        socket.on("device_hello", async (raw: any) => {
            try {
                const data = typeof raw === "string" ? JSON.parse(raw) : raw;
                if (!data || typeof data !== "object") return;
                const role = String(socket.data.role || "");
                const deviceId = String(data.deviceId || socket.data.deviceId || "");
                const hello: DeviceHello = { ...data, deviceId, role, at: Date.now() };
                this.deviceHello.set(deviceId, hello);

                const pending = this.pendingMapTimers.get(deviceId);
                if (pending) {
                    clearTimeout(pending);
                    this.pendingMapTimers.delete(deviceId);
                }
                logger.info({
                    deviceId, role, firmware: data.firmware, mapRev: data.mapRev,
                    mapBlocks: data.mapBlocks, sd: data.sd,
                    driveSpeedPercent: data.driveSpeedPercent, turnSpeedPercent: data.turnSpeedPercent,
                }, "Device hello received");

                if (role === "esp_32") {
                    const reportedRev = typeof data.mapRev === "string" && data.mapRev.length ? data.mapRev : undefined;
                    if (reportedRev) this.deviceMapRev.set(deviceId, reportedRev);
                    await this.sendFieldMapIfNeeded(socket, deviceId, reportedRev);
                }
                this.io.to("authorized_room").emit("message.upsert", { Type: "device_hello", Message: hello });
                await this.broadcastStatus();
            } catch (error) {
                logger.error({ error }, "device_hello handling failed");
            }
        });

        socket.on("message.upsert", async (raw: RobotMessage) => {
            try {
                const data = typeof raw === "string" ? JSON.parse(raw) : raw;
                if (!data || typeof data.Type !== "string" || typeof data.Message !== "object") return;
                const role = String(socket.data.role || "");
                const message = { ...data.Message, deviceId: socket.data.deviceId };

                // Speed limits the rover is actually using (acked on every
                // change, on failsafe cuts and on obstacle stops).
                if (data.Type === "motion_config" && role === "esp_32") {
                    // `blockedBy` is explicit when the firmware sends it; the
                    // reason field covers older builds (obstacle/failsafe).
                    const reason = (message as any).reason as string | undefined;
                    // `blockedBy` is explicit when the firmware sends it; the
                    // reason field covers older builds (obstacle/failsafe).
                    const blockedBy = (message as MotionStatus).blockedBy
                        ?? (reason === "obstacle" || reason === "failsafe" || reason === "no-path" || reason === "emergency"
                            ? reason : undefined);
                    this.robotMotion = { ...(message as MotionStatus), blockedBy, at: Date.now() };
                    this.io.to("authorized_room").emit("message.upsert", { Type: "motion_config", Message: this.robotMotion });
                    // The front-arc planner reports state CHANGES only, so one
                    // alert per manoeuvre - never one per scan.
                    const gapText = message.gapLeftCm != null && message.gapRightCm != null
                        ? ` (gaps ${message.gapLeftCm} cm left / ${message.gapRightCm} cm right)` : "";
                    const sideText = (message as MotionStatus).avoidDir === 1 ? "right"
                        : (message as MotionStatus).avoidDir === -1 ? "left" : "a clear side";
                    if (reason === "failsafe") {
                        await this.raiseAlert("warning", "Drive failsafe triggered",
                            "The rover cut its motors because no fresh drive command arrived (app closed, controller or link dropped).",
                            "esp_32", 30_000);
                    } else if (reason === "emergency") {
                        await this.raiseAlert("warning", "Emergency stop",
                            `Something is inside the emergency line (${message.emergencyStopCm ?? 12} cm) in front of the rover - the arc planner braked immediately.`,
                            "esp_32", 20_000);
                    } else if (reason === "no-path") {
                        await this.raiseAlert("warning", "No way past - rover stopped",
                            `The rover could not drive around the plant in front of it: neither side gap is wider than the chassis${gapText}. Clear a path or drive it back manually.`,
                            "esp_32", 60_000);
                    } else if (reason === "obstacle") {
                        await this.raiseAlert("info", "Obstacle stop",
                            `The rover stopped in place: ${message.intent || "movement"} blocked inside the safety distance (${message.obstacleStopCm ?? 30} cm) and the avoid assist is switched off.`,
                            "esp_32", 30_000);
                    } else if (reason === "avoiding") {
                        await this.raiseAlert("info", "Steering around a plant",
                            `${message.blockedBy === "plant-left" ? "A plant is blocking the left path" : message.blockedBy === "plant-right" ? "A plant is blocking the right path" : "A plant is in the way ahead"} - the rover is steering to ${sideText} instead of stopping${gapText}.`,
                            "esp_32", 25_000);
                    } else if (reason === "creep") {
                        await this.raiseAlert("info", "Creeping past a plant",
                            `The rover turned as far as it usefully can and is now creeping past the plant at crawl speed${gapText}.`,
                            "esp_32", 25_000);
                    }
                    await this.broadcastStatus();
                    return;
                }

                // Field-map cache state from the rover's SD card.
                if (data.Type === "map_status" && role === "esp_32") {
                    const rev = typeof message.rev === "string" ? message.rev : undefined;
                    if (rev) this.deviceMapRev.set(String(message.deviceId ?? socket.data.deviceId), rev);
                    this.robotMapStatus = {
                        rev, blocks: message.blocks, bytes: message.bytes, sd: message.sd,
                        reason: message.reason, at: Date.now(),
                    };
                    this.io.to("authorized_room").emit("message.upsert", { Type: "map_status", Message: this.robotMapStatus });
                    await this.broadcastStatus();
                    return;
                }

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
                    this.io.to("authorized_room").emit("message.upsert", { Type: "location", Message: message });
                    return;
                }

                if (data.Type === "sensors" && role === "esp_32") {
                    // The rover firmware also reports a raw `soilMoisture` analog value —
                    // it is not a calibrated/trustworthy reading on this hardware build, so
                    // it is deliberately dropped here and never stored or forwarded as the
                    // rover's soil moisture. Real soil moisture comes from the separate
                    // ESP32-C3 irrigation controller (Type:"irrigation", handled below).
                    const { soilMoisture: _ignoredRoverSoil, soilRaw: _ignoredRaw, ...rest } = message;
                    const previous = await this.db.getLatestSensorReading();
                    await this.db.saveSensorReading(rest);

                    const sanitized = { ...rest };
                    this.io.to("authorized_room").emit("message.upsert", { Type: "sensors", Message: sanitized });

                    if (rest.distForward != null || rest.distLeft != null || rest.distRight != null) {
                        this.io.to("authorized_room").emit("message.upsert", {
                            Type: "ultrasonic",
                            Message: { distances_cm: [rest.distForward, rest.distLeft, rest.distRight].filter((v) => v != null) },
                        });
                    }

                    if (rest.isRaining === true && (!previous || previous.is_raining !== 1)) {
                        await this.raiseAlert("warning", "Rain detected",
                            `Rain sensor triggered near ${rest.blockId || "the field"}. Consider pausing the patrol.`,
                            "esp_32", 5 * 60_000);
                    }
                    return;
                }

                if (data.Type === "irrigation" && role === "esp_c3_pump") {
                    await this.db.saveIrrigationReading({
                        deviceId: message.deviceId, pumpOn: Boolean(message.pumpOn), autoMode: Boolean(message.autoMode),
                        soilMoisture: message.soilMoisture, threshold: message.threshold, activeBlockId: message.activeBlockId,
                    });
                    await this.db.setSetting("lastIrrigation", message);
                    this.io.to("authorized_room").emit("message.upsert", { Type: "irrigation", Message: message });

                    if (typeof message.soilMoisture === "number" && !message.pumpOn && !message.autoMode
                        && message.soilMoisture < Math.max(5, (message.threshold ?? 35) - 15)) {
                        await this.raiseAlert("info", "Low soil moisture",
                            `Soil moisture is ${message.soilMoisture.toFixed(0)}% and irrigation is off. Enable auto mode or irrigate manually.`,
                            "esp_c3_pump", 30 * 60_000);
                    }
                    return;
                }

                if (data.Type === "camera_fault" && role === "esp_32") {
                    // The rover's ESP32-CAM did not deliver a frame over UART. Surface
                    // it as a real alert so the operator learns WHY no photo arrived.
                    await this.raiseAlert("warning", "Camera capture failed",
                        String(message.reason || "ESP32-CAM did not answer on the UART link. Check CAM power (5V), TX0/RX0 wiring and that no USB serial monitor is holding the line."),
                        "esp_32", 30_000);
                    return;
                }

                if (data.Type === "mission_progress" || data.Type === "mission_complete") {
                    this.lastMission = {
                        missionId: message.missionId, state: message.state,
                        currentWaypoint: message.currentWaypoint, totalWaypoints: message.totalWaypoints,
                        progress: message.progress, message: message.message,
                    };
                    if (message.state === "fault") {
                        await this.raiseAlert("critical", "Mission fault", message.message || "The robot reported a mission fault.", "esp_32");
                    }
                    await this.broadcastStatus();
                }

                if (data.Type === "mission_complete") {
                    this.robotMode = "manual"; // patrol over — the rover is back to manual driving
                    const active = await this.db.getSetting<AutonomousMission | null>("activeMission", null);
                    if (active && active.missionId === message.missionId) {
                        await this.db.completePatrol(active.patrolId);
                        const report = await this.db.buildMissionReport(active.missionId, active.patrolId);
                        const reportId = await this.db.saveAnalysisReport(
                            active.patrolId, "auto",
                            `Mission ${active.missionId} completed with ${(report as any).imageCount} analyzed images`, report);
                        await this.db.setSetting("activeMission", null);
                        this.io.to("authorized_room").emit("message.upsert", {
                            Type: "report", Message: { id: reportId, missionId: active.missionId, report }
                        });
                        await this.raiseAlert("info", "Patrol report ready",
                            `Mission ${active.missionId} analyzed ${(report as any).imageCount} images.`, "system");
                    }
                }

                this.io.to("authorized_room").emit("message.upsert", { Type: data.Type, Message: message });
            } catch (error) {
                logger.error({ error }, "Device message processing failed");
            }
        });
    }

    /* ------------------------------------------------------------------ */
    /* Authorized client (dashboard/mobile) → server                       */
    /* ------------------------------------------------------------------ */

    private handleAuthorizedClient(socket: Socket): void {
        socket.on("control_message", async (data: any, callback?: (result: any) => void) => {
            const ack = (result: any) => typeof callback === "function" && callback(result);
            try {
                if (!data || typeof data.action !== "string") return ack({ success: false, reason: "Invalid command" });

                if (UNSUPPORTED_ACTIONS.has(data.action)) {
                    return ack({ success: false, reason: `"${data.action}" is not supported by this hardware build` });
                }

                if (data.action === "save_field_map") {
                    const map = data.data as FieldMapMessage;
                    if (!this.validMap(map)) return ack({ success: false, reason: "Invalid field map" });
                    const rev = mapRevision(map);
                    const stored: FieldMapMessage = { ...map, rev };
                    await this.db.setSetting("fieldMap", stored);
                    this.io.emit("message.upsert", { Type: "map", Message: stored });
                    // The revision changed, so every rover's SD cache is by
                    // definition out of date - send the new map straight away.
                    this.io.to("esp_32_room").emit("control_command", {
                        command: { action: "field_map", data: stored, timestamp: Date.now() },
                    });
                    return ack({ success: true, message: `Field map saved (rev ${rev})`, data: { rev } });
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
                if (data.action === "acknowledge_alerts") {
                    // Purely a server/DB concern — never forwarded to a device.
                    const ids = Array.isArray(data.data?.ids) ? data.data.ids as number[] : undefined;
                    const changed = await this.db.acknowledgeAlerts(ids);
                    return ack({ success: true, message: `${changed} alert(s) acknowledged` });
                }
                if (data.action === "apply_config") {
                    const current = await this.getFleetConfig();
                    const merged: FleetConfig = {
                        rowSpacingM: Number(data.data?.rowSpacingM) || DEFAULT_FLEET_CONFIG.rowSpacingM,
                        scanSpacingM: Number(data.data?.scanSpacingM) || DEFAULT_FLEET_CONFIG.scanSpacingM,
                        arrivalRadiusM: Number(data.data?.arrivalRadiusM) || DEFAULT_FLEET_CONFIG.arrivalRadiusM,
                        irrigationThresholdPercent: Number(data.data?.irrigationThresholdPercent) || DEFAULT_FLEET_CONFIG.irrigationThresholdPercent,
                        diseaseAlertThreshold: Number(data.data?.diseaseAlertThreshold) || DEFAULT_FLEET_CONFIG.diseaseAlertThreshold,
                        driveSpeedPercent: clampPercent(data.data?.driveSpeedPercent, current.driveSpeedPercent),
                        turnSpeedPercent: clampPercent(data.data?.turnSpeedPercent, current.turnSpeedPercent),
                        sensorAngleLeftDeg: clampAngle(data.data?.sensorAngleLeftDeg, current.sensorAngleLeftDeg),
                        sensorAngleRightDeg: clampAngle(data.data?.sensorAngleRightDeg, current.sensorAngleRightDeg),
                        avoidAssist: data.data?.avoidAssist === undefined ? current.avoidAssist : data.data.avoidAssist !== false,
                    };
                    await this.db.setSetting("fleetConfig", merged);
                    if (this.isPumpOnline()) {
                        this.io.to("pump_room").emit("control_command", {
                            command: { action: "set_irrigation_threshold", data: { moisturePercent: merged.irrigationThresholdPercent } },
                        });
                    }
                    // Speed limits take effect immediately on the rover as well.
                    if (this.isRobotOnline()) this.emitMotionConfig(merged, socket.id);
                    return ack({ success: true, message: "Configuration saved", data: merged });
                }
                if (data.action === "set_speed") {
                    // Convenience form: { percent } sets the drive speed (and
                    // scales the turn speed with it); explicit
                    // { driveSpeedPercent, turnSpeedPercent } sets both.
                    const percent = data.data?.percent;
                    return ack(await this.setMotionConfig({
                        driveSpeedPercent: data.data?.driveSpeedPercent ?? percent,
                        turnSpeedPercent: data.data?.turnSpeedPercent ?? percent,
                        sensorAngleLeftDeg: data.data?.sensorAngleLeftDeg,
                        sensorAngleRightDeg: data.data?.sensorAngleRightDeg,
                        avoidAssist: data.data?.avoidAssist,
                    }, socket.id));
                }
                if (data.action === "deploy_mission") {
                    return ack(await this.deployMission(data.data ?? {}, socket.id));
                }
                if (data.action === "start_patrol") await this.db.startPatrol("Started from client");

                // change_mode / manual_teleop don't exist as robot firmware commands —
                // translate them onto the primitives the firmware actually understands
                // (pause_patrol / start_patrol), which is exactly what "manual driving"
                // means on this hardware (autonomousPaused=true, then plain `drive`).
                if (data.action === "change_mode" || data.action === "manual_teleop") {
                    const wantsManual = data.action === "manual_teleop"
                        ? Boolean(data.data?.enabled)
                        : data.data?.mode === "manual" || data.data?.mode === "paused";
                    return ack(await this.setRobotMode(wantsManual ? "manual" : "autonomous", socket.id));
                }

                if (PUMP_ACTIONS.has(data.action)) {
                    return ack(await this.controlPump(data.action, data.data, socket.id));
                }
                return ack(await this.controlRobot(data.action, data.data, socket.id));
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
