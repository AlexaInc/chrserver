/**
 * db/Sqlight.ts — chrserver SQLite database
 * ------------------------------------------
 * Uses the packages already in package.json: sqlite (promise wrapper) + sqlite3.
 *
 * Design (per project decisions):
 *  - NO users / sessions tables — single admin from env, tokens in the in-memory Map.
 *  - Data is collected per PATROL (a run). When a patrol completes (or on manual
 *    trigger) the collected rows are analyzed in one batch → an analysis report row.
 *  - Robot sensors: GPS + 4–5 ultrasonic (no lidar).
 *
 * Tables:
 *   patrols            one row per patrol run (running → completed → analyzed)
 *   location_history   GPS fixes, linked to the active patrol
 *   sensor_readings    moisture/temperature/humidity ticks (RobotMessageContent)
 *   ultrasonic_readings distances of the 4–5 ultrasonic sensors per tick (JSON array)
 *   analysis_reports   batch-analysis output per patrol (auto or manual trigger)
 *   settings           key/value store (fleet config, thresholds, anything)
 *   crop_batches       crop data (variety, block, planted date, notes)
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
    moisture_raw: number | null;
    moisture_percent: number | null;
    temperature: number | null;
    humidity: number | null;
    received_at: number;
}

export interface UltrasonicRow {
    id: number;
    patrol_id: number | null;
    distances_cm: string;          // JSON array e.g. "[120.5, 98.2, 200, 45.1, 300]"
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
    planted_at: string | null;     // ISO date
    notes: string | null;
    created_at: number;
}

/** Matches wsserver.ts RobotMessageContent */
export interface SensorMessage {
    moisture?: { raw_value: number; moisture_percent: number };
    temperature?: number;
    humidity?: number;
}

/* ------------------------------------------------------------------ */
/* Database                                                             */
/* ------------------------------------------------------------------ */

const DB_PATH = process.env.CHR_DB_PATH || path.join(__dirname, "chr.db");
const now = (): number => Date.now();

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
                moisture_raw     REAL,
                moisture_percent REAL,
                temperature      REAL,
                humidity         REAL,
                received_at      INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sensor_patrol ON sensor_readings(patrol_id);

            CREATE TABLE IF NOT EXISTS ultrasonic_readings (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                patrol_id    INTEGER REFERENCES patrols(id) ON DELETE SET NULL,
                distances_cm TEXT NOT NULL,          -- JSON array, index = sensor number
                received_at  INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_ultra_patrol ON ultrasonic_readings(patrol_id);

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
        `);
        return new CHRDatabase(db);
    }

    /* ================================================================ */
    /* Patrols — the batch unit everything hangs off                     */
    /* ================================================================ */

    /** Start a patrol; returns its id. Any already-running patrol is aborted first. */
    public async startPatrol(notes?: string): Promise<number> {
        await this.db.run(
            `UPDATE patrols SET status='aborted', ended_at=? WHERE status='running'`, now());
        const r = await this.db.run(
            `INSERT INTO patrols (started_at, notes) VALUES (?, ?)`, now(), notes ?? null);
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

    /** Type:"sensors" (RobotMessageContent) → moisture/temp/humidity tick. */
    public async saveSensorReading(m: SensorMessage): Promise<void> {
        const patrol = await this.getActivePatrol();
        await this.db.run(
            `INSERT INTO sensor_readings (patrol_id, moisture_raw, moisture_percent, temperature, humidity, received_at)
             VALUES (?,?,?,?,?,?)`,
            patrol?.id ?? null,
            m.moisture?.raw_value ?? null, m.moisture?.moisture_percent ?? null,
            m.temperature ?? null, m.humidity ?? null, now());
    }

    /** Type:"ultrasonic" → distances of the 4–5 sensors, e.g. [120.5, 98.2, 200, 45.1]. */
    public async saveUltrasonic(distancesCm: number[]): Promise<void> {
        const patrol = await this.getActivePatrol();
        await this.db.run(
            `INSERT INTO ultrasonic_readings (patrol_id, distances_cm, received_at) VALUES (?,?,?)`,
            patrol?.id ?? null, JSON.stringify(distancesCm), now());
    }

    /* ================================================================ */
    /* Batch analysis — loop over a patrol's collected data              */
    /* ================================================================ */

    /** Everything collected during one patrol — feed this to your analysis loop. */
    public async getPatrolData(patrolId: number): Promise<{
        patrol: PatrolRow | undefined;
        locations: LocationRow[];
        sensors: SensorReadingRow[];
        ultrasonic: Array<Omit<UltrasonicRow, "distances_cm"> & { distances_cm: number[] }>;
    }> {
        const [patrol, locations, sensors, ultraRaw] = await Promise.all([
            this.db.get<PatrolRow>(`SELECT * FROM patrols WHERE id=?`, patrolId),
            this.db.all<LocationRow[]>(
                `SELECT * FROM location_history WHERE patrol_id=? ORDER BY received_at`, patrolId),
            this.db.all<SensorReadingRow[]>(
                `SELECT * FROM sensor_readings WHERE patrol_id=? ORDER BY received_at`, patrolId),
            this.db.all<UltrasonicRow[]>(
                `SELECT * FROM ultrasonic_readings WHERE patrol_id=? ORDER BY received_at`, patrolId),
        ]);
        return {
            patrol, locations, sensors,
            ultrasonic: ultraRaw.map((u) => ({ ...u, distances_cm: JSON.parse(u.distances_cm) as number[] })),
        };
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

    /* ================================================================ */
    /* Location history (map trail / history view)                       */
    /* ================================================================ */

    /** Last `limit` fixes, oldest→newest — map trail after a restart. */
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

    /* ================================================================ */
    /* Housekeeping                                                      */
    /* ================================================================ */

    /** Delete raw tick data older than `days` (reports & patrols rows are kept). */
    public async prune(days = 30): Promise<void> {
        const cutoff = now() - days * 86400000;
        await this.db.run(`DELETE FROM location_history WHERE received_at < ?`, cutoff);
        await this.db.run(`DELETE FROM sensor_readings WHERE received_at < ?`, cutoff);
        await this.db.run(`DELETE FROM ultrasonic_readings WHERE received_at < ?`, cutoff);
    }

    public close(): Promise<void> {
        return this.db.close();
    }
}
