/**
 * db/Sqlight.ts — chrserver SQLite database
 * ------------------------------------------
 * Uses the packages already in package.json: sqlite (promise wrapper) + sqlite3.
 *
 * Design (per project decisions):
 *  - NO users / sessions tables — single admin from env, tokens in the in-memory Map.
 *  - Data is collected per PATROL (a run). When a patrol completes (or on manual
 *    trigger) the collected rows are analyzed in one batch → an analysis report row.
 *  - Robot (rover, role "esp_32") sensors that are ACTUALLY wired and trustworthy:
 *    GPS, DHT22 (temperature/humidity), rain gauge, 3x ultrasonic (front/left/right),
 *    and the AI camera (photos). The rover also exposes a raw soil-moisture analog
 *    pin in firmware, but it is NOT a reliable/calibrated reading on this build, so it
 *    is intentionally never persisted or trusted here — see WSServer.handleDevice().
 *  - Soil moisture that IS trustworthy comes from the separate ESP32-C3 irrigation
 *    controller (role "esp_c3_pump"), stored in irrigation_readings.
 *
 * Tables:
 *   patrols             one row per patrol run (running → completed → analyzed)
 *   location_history    GPS fixes, linked to the active patrol
 *   sensor_readings      rover DHT22/rain/ultrasonic ticks
 *   analysis_reports    batch-analysis output per patrol (auto or manual trigger)
 *   settings             key/value store (fleet config, thresholds, anything)
 *   crop_batches        crop data (variety, block, planted date, notes)
 *   image_scans         one row per uploaded+analyzed photo
 *   irrigation_readings pump controller ticks (real soil moisture + pump state)
 *   alerts              server-raised alerts from real, observable conditions
 *
 * Usage:
 *   import { CHRDatabase } from "../../db/Sqlight";
 *   const db = await CHRDatabase.open();           // in startApp(), before WSServer
 */

import { open, Database } from "sqlite";
import sqlite3 from "sqlite3";
import path from "path";

/* ------------------------------------------------------------------ */
/* Row types                                                            */
/* ------------------------------------------------------------------ */

export type PatrolStatus = "running" | "completed" | "aborted" | "analyzed";

export interface PatrolRow {
    id: number;
    started_at: number;            // epoch ms
    ended_at: number | null;
    status: PatrolStatus;
    notes: string | null;
    mode?: "auto" | "manual" | "mapping";
    block_ids?: string | null;
}

export interface LocationRow {
    id: number;
    patrol_id: number | null;      // null = fix received while no patrol running
    latitude: number;
    longitude: number;
    altitude: number | null;
    satellites: number | null;
    received_at: number;
}

export interface SensorReadingRow {
    id: number;
    patrol_id: number | null;
    temperature: number | null;
    humidity: number | null;
    rain_percent: number | null;
    is_raining: number | null;     // 0/1
    dist_forward_cm: number | null;
    dist_left_cm: number | null;
    dist_right_cm: number | null;
    block_id: string | null;
    plant: string | null;
    received_at: number;
}

export type ReportTrigger = "auto" | "manual";

export interface AnalysisReportRow {
    id: number;
    patrol_id: number;
    trigger_type: ReportTrigger;
    summary: string;               // short human-readable summary line
    report: string;                // full JSON report body
    created_at: number;
}

export interface CropBatchRow {
    id: number;
    crop: string;
    block: string | null;
    planted_at: string | null;
    notes: string | null;
    created_at: number;
}

export interface ImageScanRow {
    id: number;
    patrol_id: number;
    mission_id: string;
    block_id: string;
    plant: string;
    scan_point: number;
    side: string;
    image_path: string;
    predictions: string;
    created_at: number;
}

export interface IrrigationReadingRow {
    id: number;
    device_id: string;
    pump_on: number;
    auto_mode: number;
    soil_moisture: number | null;
    threshold: number | null;
    active_block_id: string | null;
    received_at: number;
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface AlertRow {
    id: number;
    severity: AlertSeverity;
    title: string;
    description: string | null;
    source: string;                // e.g. "esp_32", "esp_c3_pump", "ai_scan", "system"
    created_at: number;
    acknowledged_at: number | null;
}

/* ------------------------------------------------------------------ */
/* WhatsApp service state                                              */
/* ------------------------------------------------------------------ */

/**
 * Persisted WhatsApp-service state (settings key `whatsapp`).
 *
 * Numbers are stored in E.164 *digital* form — country code included, no
 * `+`, no spaces, no leading `0` — e.g. Sri Lanka 076 604 5156 becomes
 * "94766045156". Everything the bot compares (command gate) and everything
 * the frontend shows comes from here, so the owner number survives server
 * restarts instead of being a hardcoded `null`.
 */
export interface WhatsAppSettings {
    /**
     * Primary owner number (country code included) — always `ownerNumbers[0]`.
     * Kept for older clients/routes that still speak about "the owner number".
     */
    ownerNumber: string | null;
    /**
     * EVERY number allowed to command the robot/pump. Up to MAX_OWNER_NUMBERS,
     * all of them receive the alerts (rain, petrol empty, faults). A farm has
     * more than one person who may need to stop a pump.
     */
    ownerNumbers: string[];
    /** Start the WhatsApp service automatically on boot. */
    enabled: boolean;
    /** Number the current/past bot session was paired for (country code included). */
    linkedNumber: string | null;
    /** epoch ms of the last successful pairing. */
    linkedAt: number | null;
    /** LIDs we have learned belong to the owner (WhatsApp hides the phone
     *  number of some chats behind `@lid`; we remember the ones the owner
     *  actually sent from so the gate keeps working). */
    ownerLids: string[];
}

export const DEFAULT_WHATSAPP_SETTINGS: WhatsAppSettings = {
    ownerNumber: null,
    ownerNumbers: [],
    enabled: false,
    linkedNumber: null,
    linkedAt: null,
    ownerLids: [],
};

/** Hard cap agreed with the operator's specification. */
export const MAX_OWNER_NUMBERS = 10;

/** What the rover ("esp_32") actually reports per tick — Type:"sensors". */
export interface RoverSensorMessage {
    temperature?: number;
    humidity?: number;
    rainDrop?: number;
    isRaining?: boolean;
    distForward?: number;
    distLeft?: number;
    distRight?: number;
    blockId?: string;
    plant?: string;
}

/* ------------------------------------------------------------------ */
/* Database                                                             */
/* ------------------------------------------------------------------ */

const DB_PATH = process.env.CHR_DB_PATH || path.join(__dirname, "chr.db");
const now = (): number => Date.now();

async function columnExists(db: Database, table: string, column: string): Promise<boolean> {
    const rows = await db.all<{ name: string }[]>(`PRAGMA table_info(${table})`);
    return rows.some((r) => r.name === column);
}

export class CHRDatabase {
    private constructor(private db: Database) {}

    /** Open (and create/migrate) the database. Call once at startup. */
    public static async open(dbPath: string = DB_PATH): Promise<CHRDatabase> {
        const db = await open({ filename: dbPath, driver: sqlite3.Database });
        await db.exec(`
            PRAGMA journal_mode = WAL;

            CREATE TABLE IF NOT EXISTS patrols (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at INTEGER NOT NULL,
                ended_at   INTEGER,
                status     TEXT NOT NULL DEFAULT 'running'
                           CHECK (status IN ('running','completed','aborted','analyzed')),
                notes      TEXT
            );

            CREATE TABLE IF NOT EXISTS location_history (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                patrol_id   INTEGER REFERENCES patrols(id) ON DELETE SET NULL,
                latitude    REAL NOT NULL,
                longitude   REAL NOT NULL,
                altitude    REAL,
                satellites  INTEGER,
                received_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_loc_patrol ON location_history(patrol_id);
            CREATE INDEX IF NOT EXISTS idx_loc_time   ON location_history(received_at);

            CREATE TABLE IF NOT EXISTS sensor_readings (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                patrol_id        INTEGER REFERENCES patrols(id) ON DELETE SET NULL,
                temperature      REAL,
                humidity         REAL,
                rain_percent     REAL,
                is_raining       INTEGER,
                dist_forward_cm  REAL,
                dist_left_cm     REAL,
                dist_right_cm    REAL,
                block_id         TEXT,
                plant            TEXT,
                received_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sensor_patrol ON sensor_readings(patrol_id);
            CREATE INDEX IF NOT EXISTS idx_sensor_time ON sensor_readings(received_at);

            CREATE TABLE IF NOT EXISTS analysis_reports (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                patrol_id    INTEGER NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
                trigger_type TEXT NOT NULL CHECK (trigger_type IN ('auto','manual')),
                summary      TEXT NOT NULL,
                report       TEXT NOT NULL,          -- full JSON
                created_at   INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,            -- JSON value
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS crop_batches (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                crop       TEXT NOT NULL,
                block      TEXT,
                planted_at TEXT,
                notes      TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS image_scans (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                patrol_id   INTEGER NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
                mission_id  TEXT NOT NULL,
                block_id    TEXT NOT NULL,
                plant       TEXT NOT NULL,
                scan_point  INTEGER NOT NULL,
                side        TEXT NOT NULL,
                image_path  TEXT NOT NULL,
                predictions TEXT NOT NULL,
                created_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_scan_mission ON image_scans(mission_id);
            CREATE INDEX IF NOT EXISTS idx_scan_patrol ON image_scans(patrol_id);

            CREATE TABLE IF NOT EXISTS irrigation_readings (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id       TEXT NOT NULL,
                pump_on         INTEGER NOT NULL,
                auto_mode       INTEGER NOT NULL,
                soil_moisture   REAL,
                threshold       REAL,
                active_block_id TEXT,
                received_at     INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_irrigation_time ON irrigation_readings(received_at);

            CREATE TABLE IF NOT EXISTS alerts (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                severity        TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
                title           TEXT NOT NULL,
                description     TEXT,
                source          TEXT NOT NULL,
                created_at      INTEGER NOT NULL,
                acknowledged_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_alerts_time ON alerts(created_at);
        `);

        // Migrate older DBs created before rain/ultrasonic columns or the
        // block_id/plant columns existed on sensor_readings.
        const migrations: Array<[string, string]> = [
            ["temperature", "ALTER TABLE sensor_readings ADD COLUMN temperature REAL"],
            ["humidity", "ALTER TABLE sensor_readings ADD COLUMN humidity REAL"],
            ["rain_percent", "ALTER TABLE sensor_readings ADD COLUMN rain_percent REAL"],
            ["is_raining", "ALTER TABLE sensor_readings ADD COLUMN is_raining INTEGER"],
            ["dist_forward_cm", "ALTER TABLE sensor_readings ADD COLUMN dist_forward_cm REAL"],
            ["dist_left_cm", "ALTER TABLE sensor_readings ADD COLUMN dist_left_cm REAL"],
            ["dist_right_cm", "ALTER TABLE sensor_readings ADD COLUMN dist_right_cm REAL"],
            ["block_id", "ALTER TABLE sensor_readings ADD COLUMN block_id TEXT"],
            ["plant", "ALTER TABLE sensor_readings ADD COLUMN plant TEXT"],
        ];
        for (const [column, sql] of migrations) {
            if (!(await columnExists(db, "sensor_readings", column))) await db.exec(sql);
        }
        if (!(await columnExists(db, "patrols", "mode")))
            await db.exec("ALTER TABLE patrols ADD COLUMN mode TEXT NOT NULL DEFAULT 'auto'");
        if (!(await columnExists(db, "patrols", "block_ids")))
            await db.exec("ALTER TABLE patrols ADD COLUMN block_ids TEXT");

        return new CHRDatabase(db);
    }

    /* ================================================================ */
    /* Patrols — the batch unit everything hangs off                     */
    /* ================================================================ */

    /** Start a patrol; returns its id. Any already-running patrol is aborted first. */
    public async startPatrol(notes?: string, mode: "auto" | "manual" | "mapping" = "auto", blockIds: string[] = []): Promise<number> {
        await this.db.run(
            `UPDATE patrols SET status='aborted', ended_at=? WHERE status='running'`, now());
        const r = await this.db.run(
            `INSERT INTO patrols (started_at, notes, mode, block_ids) VALUES (?,?,?,?)`,
            now(), notes ?? null, mode, JSON.stringify(blockIds));
        return r.lastID as number;
    }

    /** The patrol currently running, or undefined. */
    public getActivePatrol(): Promise<PatrolRow | undefined> {
        return this.db.get<PatrolRow>(
            `SELECT * FROM patrols WHERE status='running' ORDER BY id DESC LIMIT 1`);
    }

    /** Mark the running patrol completed (call when the robot finishes a block). */
    public async completePatrol(patrolId: number): Promise<void> {
        await this.db.run(
            `UPDATE patrols SET status='completed', ended_at=? WHERE id=?`, now(), patrolId);
    }

    /** Newest completed-but-not-yet-analyzed patrol (what the analyzer should pick up). */
    public getPatrolAwaitingAnalysis(): Promise<PatrolRow | undefined> {
        return this.db.get<PatrolRow>(
            `SELECT * FROM patrols WHERE status='completed' ORDER BY ended_at DESC LIMIT 1`);
    }

    /** Most recent patrols, newest first (for a simple mission/patrol history view). */
    public getRecentPatrols(limit = 20): Promise<PatrolRow[]> {
        return this.db.all<PatrolRow[]>(`SELECT * FROM patrols ORDER BY id DESC LIMIT ?`, limit);
    }

    /* ================================================================ */
    /* Live data ingest — call from wsserver's message.upsert handler    */
    /* ================================================================ */

    /** Type:"location" → store fix (linked to active patrol if one is running). */
    public async saveLocation(
        m: { latitude: number; longitude: number; altitude?: number; satellites?: number },
    ): Promise<void> {
        const patrol = await this.getActivePatrol();
        await this.db.run(
            `INSERT INTO location_history (patrol_id, latitude, longitude, altitude, satellites, received_at)
             VALUES (?,?,?,?,?,?)`,
            patrol?.id ?? null, m.latitude, m.longitude,
            m.altitude ?? null, m.satellites ?? null, now());
    }

    /**
     * Type:"sensors" (rover DHT22 + rain + ultrasonic tick).
     * NOTE: the rover firmware also reports a raw `soilMoisture` analog reading, but it
     * is not a calibrated/trustworthy value on this hardware build — it is intentionally
     * dropped before it ever reaches this method (see WSServer.handleDevice()).
     */
    public async saveSensorReading(m: RoverSensorMessage): Promise<void> {
        const patrol = await this.getActivePatrol();
        await this.db.run(
            `INSERT INTO sensor_readings
             (patrol_id, temperature, humidity, rain_percent, is_raining,
              dist_forward_cm, dist_left_cm, dist_right_cm, block_id, plant, received_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            patrol?.id ?? null,
            m.temperature ?? null, m.humidity ?? null,
            m.rainDrop ?? null, m.isRaining == null ? null : (m.isRaining ? 1 : 0),
            m.distForward ?? null, m.distLeft ?? null, m.distRight ?? null,
            m.blockId || null, m.plant || null, now());
    }

    /** Latest rover sensor tick, or undefined if none yet. */
    public getLatestSensorReading(): Promise<SensorReadingRow | undefined> {
        return this.db.get<SensorReadingRow>(
            `SELECT * FROM sensor_readings ORDER BY received_at DESC LIMIT 1`);
    }

    /** Sensor history for charts — newest last (chronological). */
    public async getSensorHistory(sinceMs: number, limit = 500): Promise<SensorReadingRow[]> {
        const rows = await this.db.all<SensorReadingRow[]>(
            `SELECT * FROM sensor_readings WHERE received_at >= ? ORDER BY received_at DESC LIMIT ?`,
            sinceMs, limit);
        return rows.reverse();
    }

    /* ================================================================ */
    /* Irrigation / pump controller (real soil moisture lives here)      */
    /* ================================================================ */

    public async saveIrrigationReading(m: {
        deviceId: string; pumpOn: boolean; autoMode: boolean;
        soilMoisture?: number; threshold?: number; activeBlockId?: string | null;
    }): Promise<void> {
        await this.db.run(
            `INSERT INTO irrigation_readings
             (device_id, pump_on, auto_mode, soil_moisture, threshold, active_block_id, received_at)
             VALUES (?,?,?,?,?,?,?)`,
            m.deviceId, m.pumpOn ? 1 : 0, m.autoMode ? 1 : 0,
            m.soilMoisture ?? null, m.threshold ?? null, m.activeBlockId || null, now());
    }

    public getLatestIrrigationReading(): Promise<IrrigationReadingRow | undefined> {
        return this.db.get<IrrigationReadingRow>(
            `SELECT * FROM irrigation_readings ORDER BY received_at DESC LIMIT 1`);
    }

    public async getIrrigationHistory(sinceMs: number, limit = 500): Promise<IrrigationReadingRow[]> {
        const rows = await this.db.all<IrrigationReadingRow[]>(
            `SELECT * FROM irrigation_readings WHERE received_at >= ? ORDER BY received_at DESC LIMIT ?`,
            sinceMs, limit);
        return rows.reverse();
    }

    /* ================================================================ */
    /* Batch analysis — loop over a patrol's collected data              */
    /* ================================================================ */

    /** Everything collected during one patrol — feed this to your analysis loop. */
    public async getPatrolData(patrolId: number): Promise<{
        patrol: PatrolRow | undefined;
        locations: LocationRow[];
        sensors: SensorReadingRow[];
    }> {
        const [patrol, locations, sensors] = await Promise.all([
            this.db.get<PatrolRow>(`SELECT * FROM patrols WHERE id=?`, patrolId),
            this.db.all<LocationRow[]>(
                `SELECT * FROM location_history WHERE patrol_id=? ORDER BY received_at`, patrolId),
            this.db.all<SensorReadingRow[]>(
                `SELECT * FROM sensor_readings WHERE patrol_id=? ORDER BY received_at`, patrolId),
        ]);
        return { patrol, locations, sensors };
    }

    /** Save the analysis result and mark the patrol analyzed. Returns report id. */
    public async saveAnalysisReport(
        patrolId: number, trigger: ReportTrigger, summary: string, reportBody: object,
    ): Promise<number> {
        const r = await this.db.run(
            `INSERT INTO analysis_reports (patrol_id, trigger_type, summary, report, created_at)
             VALUES (?,?,?,?,?)`,
            patrolId, trigger, summary, JSON.stringify(reportBody), now());
        await this.db.run(`UPDATE patrols SET status='analyzed' WHERE id=?`, patrolId);
        return r.lastID as number;
    }

    /** Reports newest-first (for the Reports screen / sending to frontend). */
    public async getReports(limit = 20): Promise<Array<Omit<AnalysisReportRow, "report"> & { report: object }>> {
        const rows = await this.db.all<AnalysisReportRow[]>(
            `SELECT * FROM analysis_reports ORDER BY created_at DESC LIMIT ?`, limit);
        return rows.map((r) => ({ ...r, report: JSON.parse(r.report) as object }));
    }

    public async getReportById(id: number): Promise<(Omit<AnalysisReportRow, "report"> & { report: any }) | undefined> {
        const row = await this.db.get<AnalysisReportRow>(`SELECT * FROM analysis_reports WHERE id=?`, id);
        return row ? { ...row, report: JSON.parse(row.report) } : undefined;
    }

    /* ================================================================ */
    /* Location history (map trail / history view)                       */
    /* ================================================================ */

    /** Last `limit` fixes, oldest→newest — map trail after a restart. */
    /** The single newest GPS fix — used by the alert texts ("last known position"). */
    public async getLatestLocation(): Promise<LocationRow | undefined> {
        return this.db.get<LocationRow>(
            `SELECT * FROM location_history ORDER BY received_at DESC LIMIT 1`);
    }

    public async getRecentTrail(limit = 200): Promise<LocationRow[]> {
        const rows = await this.db.all<LocationRow[]>(
            `SELECT * FROM location_history ORDER BY received_at DESC LIMIT ?`, limit);
        return rows.reverse();
    }

    /** Fixes between two times (history playback). */
    public getLocationsBetween(fromMs: number, toMs: number): Promise<LocationRow[]> {
        return this.db.all<LocationRow[]>(
            `SELECT * FROM location_history WHERE received_at BETWEEN ? AND ? ORDER BY received_at`,
            fromMs, toMs);
    }

    /* ================================================================ */
    /* Settings — key/value JSON store                                   */
    /* ================================================================ */

    public async setSetting<T>(key: string, value: T): Promise<void> {
        await this.db.run(
            `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
            key, JSON.stringify(value), now());
    }

    public async getSetting<T>(key: string, fallback: T): Promise<T> {
        const row = await this.db.get<{ value: string }>(
            `SELECT value FROM settings WHERE key=?`, key);
        return row ? (JSON.parse(row.value) as T) : fallback;
    }

    /** All settings as one object (send to frontend after login). */
    public async getAllSettings(): Promise<Record<string, unknown>> {
        const rows = await this.db.all<{ key: string; value: string }[]>(
            `SELECT key, value FROM settings`);
        return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    }

    /* ================================================================ */
    /* Crops                                                             */
    /* ================================================================ */

    public async registerCropBatch(
        b: { crop: string; block?: string; plantedAt?: string; notes?: string },
    ): Promise<number> {
        const r = await this.db.run(
            `INSERT INTO crop_batches (crop, block, planted_at, notes, created_at) VALUES (?,?,?,?,?)`,
            b.crop, b.block ?? null, b.plantedAt ?? null, b.notes ?? null, now());
        return r.lastID as number;
    }

    public getCropBatches(): Promise<CropBatchRow[]> {
        return this.db.all<CropBatchRow[]>(
            `SELECT * FROM crop_batches ORDER BY created_at DESC`);
    }

    public async saveImageScan(scan: {
        patrolId: number; missionId: string; blockId: string; plant: string;
        scanPoint: number; side: string; imagePath: string;
        predictions: Array<{ className: string; confidence: number }>;
    }): Promise<number> {
        const r = await this.db.run(
            `INSERT INTO image_scans
             (patrol_id, mission_id, block_id, plant, scan_point, side, image_path, predictions, created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            scan.patrolId, scan.missionId, scan.blockId, scan.plant, scan.scanPoint,
            scan.side, scan.imagePath, JSON.stringify(scan.predictions), now());
        return r.lastID as number;
    }

    public async getMissionScans(missionId: string): Promise<Array<Omit<ImageScanRow, "predictions"> & { predictions: Array<{className:string; confidence:number}> }>> {
        const rows = await this.db.all<ImageScanRow[]>(
            `SELECT * FROM image_scans WHERE mission_id=? ORDER BY scan_point, side`, missionId);
        return rows.map((r) => ({ ...r, predictions: JSON.parse(r.predictions) }));
    }

    public async getRecentScans(limit = 20): Promise<Array<Omit<ImageScanRow, "predictions"> & { predictions: Array<{className:string; confidence:number}> }>> {
        const rows = await this.db.all<ImageScanRow[]>(
            `SELECT * FROM image_scans ORDER BY created_at DESC LIMIT ?`, limit);
        return rows.map((r) => ({ ...r, predictions: JSON.parse(r.predictions) }));
    }

    public getScanById(id: number): Promise<ImageScanRow | undefined> {
        return this.db.get<ImageScanRow>(`SELECT * FROM image_scans WHERE id=?`, id);
    }

    public async getPhotoCollections(limit = 50): Promise<any[]> {
        const patrols = await this.db.all<any[]>(
            `SELECT p.*, COUNT(s.id) AS photo_count, MIN(s.created_at) AS first_photo_at,
                    MAX(s.created_at) AS last_photo_at
             FROM patrols p LEFT JOIN image_scans s ON s.patrol_id=p.id
             GROUP BY p.id HAVING photo_count > 0 ORDER BY p.id DESC LIMIT ?`, limit);
        const out: any[] = [];
        for (const patrol of patrols) {
            const scans = await this.getPatrolScans(patrol.id);
            const report = await this.db.get<AnalysisReportRow>(
                `SELECT * FROM analysis_reports WHERE patrol_id=? ORDER BY id DESC LIMIT 1`, patrol.id);
            out.push({ ...patrol, block_ids: patrol.block_ids ? JSON.parse(patrol.block_ids) : [], scans,
                report: report ? { ...report, report: JSON.parse(report.report) } : null });
        }
        return out;
    }

    public async getPatrolScans(patrolId: number): Promise<Array<Omit<ImageScanRow, "predictions"> & { predictions: Array<{className:string; confidence:number}> }>> {
        const rows = await this.db.all<ImageScanRow[]>(
            `SELECT * FROM image_scans WHERE patrol_id=? ORDER BY created_at`, patrolId);
        return rows.map((r) => ({ ...r, predictions: JSON.parse(r.predictions) }));
    }

    public async updateScanPredictions(id: number, predictions: Array<{className:string; confidence:number}>): Promise<void> {
        await this.db.run(`UPDATE image_scans SET predictions=? WHERE id=?`, JSON.stringify(predictions), id);
    }

    public async replacePatrolReport(patrolId: number, trigger: ReportTrigger, summary: string, reportBody: object): Promise<number> {
        await this.db.run(`DELETE FROM analysis_reports WHERE patrol_id=?`, patrolId);
        return this.saveAnalysisReport(patrolId, trigger, summary, reportBody);
    }

    public async deleteScan(id: number): Promise<ImageScanRow | undefined> {
        const scan = await this.getScanById(id);
        if (scan) {
            await this.db.run(`DELETE FROM image_scans WHERE id=?`, id);
            // A saved report embeds its scan list. Remove it so deleted photos
            // and predictions can never remain visible through stale JSON.
            await this.db.run(`DELETE FROM analysis_reports WHERE patrol_id=?`, scan.patrol_id);
            await this.db.run(`UPDATE patrols SET status='completed' WHERE id=? AND status='analyzed'`, scan.patrol_id);
        }
        return scan;
    }

    public async deletePhotoCollection(patrolId: number): Promise<string[]> {
        const scans = await this.db.all<ImageScanRow[]>(`SELECT * FROM image_scans WHERE patrol_id=?`, patrolId);
        await this.db.run(`DELETE FROM analysis_reports WHERE patrol_id=?`, patrolId);
        await this.db.run(`DELETE FROM image_scans WHERE patrol_id=?`, patrolId);
        await this.db.run(`DELETE FROM patrols WHERE id=?`, patrolId);
        return scans.map((s) => s.image_path);
    }

    public async buildMissionReport(missionId: string, patrolId: number): Promise<object> {
        const scans = await this.getMissionScans(missionId);
        const sums = new Map<string, { sum: number; count: number }>();
        for (const scan of scans) for (const p of scan.predictions) {
            const v = sums.get(p.className) ?? { sum: 0, count: 0 };
            v.sum += Number(p.confidence) || 0; v.count++; sums.set(p.className, v);
        }
        const averages = [...sums].map(([className, v]) => ({ className, averageConfidence: v.sum / v.count, samples: v.count }))
            .sort((a, b) => b.averageConfidence - a.averageConfidence);
        const blocks = [...new Set(scans.map((s) => s.block_id))];
        return { missionId, patrolId, imageCount: scans.length, blocks, averages, scans, completedAt: now() };
    }

    /* ================================================================ */
    /* Alerts — raised only from real, observable conditions              */
    /* ================================================================ */

    public async createAlert(a: {
        severity: AlertSeverity; title: string; description?: string; source: string;
    }): Promise<AlertRow> {
        const r = await this.db.run(
            `INSERT INTO alerts (severity, title, description, source, created_at) VALUES (?,?,?,?,?)`,
            a.severity, a.title, a.description ?? null, a.source, now());
        return (await this.db.get<AlertRow>(`SELECT * FROM alerts WHERE id=?`, r.lastID))!;
    }

    public listAlerts(limit = 50, onlyUnacknowledged = false): Promise<AlertRow[]> {
        return this.db.all<AlertRow[]>(
            onlyUnacknowledged
                ? `SELECT * FROM alerts WHERE acknowledged_at IS NULL ORDER BY created_at DESC LIMIT ?`
                : `SELECT * FROM alerts ORDER BY created_at DESC LIMIT ?`,
            limit);
    }

    public async countUnacknowledgedAlerts(): Promise<number> {
        const row = await this.db.get<{ n: number }>(
            `SELECT COUNT(*) as n FROM alerts WHERE acknowledged_at IS NULL`);
        return row?.n ?? 0;
    }

    /**
     * Acknowledge every still-open alert with the same title. Repeat alerts (the
     * noisy GPS / field-map / low-moisture ones) therefore never stack up: only
     * the newest one stays open, so the app's badge falls back to zero without
     * anybody pressing "acknowledge".
     */
    public async acknowledgeSuperseded(title: string): Promise<number> {
        const r = await this.db.run(
            `UPDATE alerts SET acknowledged_at=? WHERE title=? AND acknowledged_at IS NULL`, now(), title);
        return r.changes ?? 0;
    }

    /** The most recent alert of `title`, used to throttle repeat alerts (e.g. rain). */
    public getLastAlertByTitle(title: string): Promise<AlertRow | undefined> {
        return this.db.get<AlertRow>(
            `SELECT * FROM alerts WHERE title=? ORDER BY created_at DESC LIMIT 1`, title);
    }

    public async acknowledgeAlerts(ids?: number[]): Promise<number> {
        if (ids && ids.length) {
            const placeholders = ids.map(() => "?").join(",");
            const r = await this.db.run(
                `UPDATE alerts SET acknowledged_at=? WHERE id IN (${placeholders}) AND acknowledged_at IS NULL`,
                now(), ...ids);
            return r.changes ?? 0;
        }
        const r = await this.db.run(
            `UPDATE alerts SET acknowledged_at=? WHERE acknowledged_at IS NULL`, now());
        return r.changes ?? 0;
    }

    /* ================================================================ */
    /* WhatsApp service state (owner number + session bookkeeping)       */
    /* ================================================================ */

    /**
     * Full WhatsApp settings, defaults filled in for older DBs.
     *
     * Migration: a database written before owner numbers became a list still has
     * the single `ownerNumber`; it is promoted to the first entry of the list so
     * nothing is lost and the command gate keeps working.
     */
    public async getWhatsAppSettings(): Promise<WhatsAppSettings> {
        const stored = await this.getSetting<Partial<WhatsAppSettings>>("whatsapp", {});
        const list = Array.isArray(stored.ownerNumbers)
            ? stored.ownerNumbers.filter((n): n is string => typeof n === "string" && n.length > 0)
            : [];
        const ownerNumbers = (list.length ? list : stored.ownerNumber ? [stored.ownerNumber] : [])
            .filter((n, i, all) => all.indexOf(n) === i)
            .slice(0, MAX_OWNER_NUMBERS);
        return {
            ...DEFAULT_WHATSAPP_SETTINGS,
            ...stored,
            ownerNumbers,
            ownerNumber: ownerNumbers[0] ?? null,
            ownerLids: Array.isArray(stored.ownerLids) ? stored.ownerLids : [],
        };
    }

    /** Save the whole list (the cap and the primary number stay consistent). */
    public async setOwnerNumbers(numbers: string[]): Promise<WhatsAppSettings> {
        const list = numbers
            .filter((n) => typeof n === "string" && n.length > 0)
            .filter((n, i, all) => all.indexOf(n) === i)
            .slice(0, MAX_OWNER_NUMBERS);
        return this.saveWhatsAppSettings({ ownerNumbers: list, ownerNumber: list[0] ?? null, ownerLids: [] });
    }

    /** Merge-and-save (partial updates are fine). */
    public async saveWhatsAppSettings(patch: Partial<WhatsAppSettings>): Promise<WhatsAppSettings> {
        const merged: WhatsAppSettings = { ...(await this.getWhatsAppSettings()), ...patch };
        await this.setSetting("whatsapp", merged);
        return merged;
    }

    /* ================================================================ */
    /* Housekeeping                                                      */
    /* ================================================================ */

    /** Delete raw tick data older than `days` (reports & patrols rows are kept). */
    public async prune(days = 30): Promise<void> {
        const cutoff = now() - days * 86400000;
        await this.db.run(`DELETE FROM location_history WHERE received_at < ?`, cutoff);
        await this.db.run(`DELETE FROM sensor_readings WHERE received_at < ?`, cutoff);
        await this.db.run(`DELETE FROM irrigation_readings WHERE received_at < ?`, cutoff);
    }

    public close(): Promise<void> {
        return this.db.close();
    }
}
