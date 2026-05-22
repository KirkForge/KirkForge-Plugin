import { ok, err, type Result } from "@55ndeep/core-types";
import type { MemoryAdapter, MemoryObject, MemoryQuery, MemoryStats } from "./index.js";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

export class SqliteAdapter implements MemoryAdapter {
  private db: any;
  private filePath: string;
  // Cached prepared statements (B9)
  private _stmtInsertObs!: any;
  private _stmtInsertRun!: any;
  private _stmtInsertEmission!: any;
  private _stmtDeleteEmissionsByRun!: any;
  private _stmtBeginTx!: any;
  private _stmtCommit!: any;
  private _stmtRollback!: any;

  constructor(filePath: string) {
    let Database: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      Database = require("better-sqlite3");
    } catch {
      throw new Error(
        "SQLite adapter requires optional dependency better-sqlite3. " +
          "Install it (npm install better-sqlite3) or use FileMemoryAdapter instead.",
      );
    }
    this.filePath = resolve(filePath);
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.db = new Database(this.filePath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        task_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        description TEXT NOT NULL,
        properties TEXT NOT NULL,
        tags TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_obs_kind ON observations(kind)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_obs_task_id ON observations(task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_obs_timestamp ON observations(timestamp)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_obs_tags ON observations(tags)");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        description TEXT NOT NULL,
        language TEXT NOT NULL,
        task_family TEXT,
        mode TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL DEFAULT '',
        provider_type TEXT NOT NULL DEFAULT '',
        base_url TEXT,
        outcome TEXT NOT NULL,
        outcome_class TEXT NOT NULL,
        routing_lesson TEXT NOT NULL DEFAULT 'neutral',
        final_verdict TEXT NOT NULL,
        source_of_truth TEXT NOT NULL,
        final_action TEXT NOT NULL,
        tokens INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        turns INTEGER NOT NULL DEFAULT 0,
        validator_duration_ms INTEGER NOT NULL DEFAULT 0,
        verifier_overall TEXT,
        files_emitted INTEGER NOT NULL DEFAULT 0,
        total_bytes_emitted INTEGER NOT NULL DEFAULT 0,
        emission_ids TEXT NOT NULL DEFAULT '[]',
        timestamp TEXT NOT NULL
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_task_id ON runs(task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_outcome_class ON runs(outcome_class)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_timestamp ON runs(timestamp)");
    // Migration: add emission_ids column if missing (pre-1.1 databases)
    try {
      this.db.exec("ALTER TABLE runs ADD COLUMN emission_ids TEXT NOT NULL DEFAULT '[]'");
    } catch {
      /* column already exists */
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS emissions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        turn INTEGER NOT NULL DEFAULT 0,
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0,
        before_hash TEXT,
        existed INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_emissions_task_id ON emissions(task_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_emissions_run_id ON emissions(run_id)");
    // Migration: add turn column if missing (pre-1.1 databases)
    try {
      this.db.exec("ALTER TABLE emissions ADD COLUMN turn INTEGER NOT NULL DEFAULT 0");
    } catch {
      /* column already exists */
    }

    // Schema versioning for future migrations
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    // Seed initial version if empty
    const versionRow = this.db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as
      | { v: number | null }
      | undefined;
    if (!versionRow || versionRow.v === null) {
      this.db
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString());
    }

    // Cache prepared statements for performance (B9)
    this._stmtInsertObs = this.db.prepare(
      "INSERT OR REPLACE INTO observations (id, kind, task_id, timestamp, description, properties, tags) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this._stmtInsertRun = this.db.prepare(
      `INSERT OR REPLACE INTO runs
       (run_id, task_id, description, language, task_family, mode, model,
        provider_key, provider_type, base_url, outcome, outcome_class,
        routing_lesson, final_verdict, source_of_truth, final_action,
        tokens, duration_ms, turns, validator_duration_ms, verifier_overall,
        files_emitted, total_bytes_emitted, emission_ids, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._stmtInsertEmission = this.db.prepare(
      `INSERT OR REPLACE INTO emissions
       (id, run_id, task_id, turn, path, sha256, bytes, before_hash, existed, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this._stmtDeleteEmissionsByRun = this.db.prepare("DELETE FROM emissions WHERE run_id = ?");
    this._stmtBeginTx = this.db.prepare("BEGIN IMMEDIATE");
    this._stmtCommit = this.db.prepare("COMMIT");
    this._stmtRollback = this.db.prepare("ROLLBACK");
  }

  async write(obj: MemoryObject): Promise<Result<void, Error>> {
    try {
      this._stmtInsertObs.run(
        obj.id,
        obj.kind,
        obj.taskId,
        obj.timestamp,
        obj.description,
        JSON.stringify(obj.properties),
        JSON.stringify(obj.tags),
      );
      return ok(undefined);
    } catch (cause) {
      return err(
        new Error(
          `SqliteAdapter write failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  async read(id: string): Promise<Result<MemoryObject | null, Error>> {
    try {
      const stmt = this.db.prepare("SELECT * FROM observations WHERE id = ?");
      const row = stmt.get(id) as Row | undefined;
      if (!row) return ok(null);
      return ok(this._rowToObject(row));
    } catch (cause) {
      return err(
        new Error(
          `SqliteAdapter read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  async query(q: MemoryQuery): Promise<Result<MemoryObject[], Error>> {
    try {
      const conditions: string[] = [];
      const params: (string | number | null)[] = [];

      if (q.kind) {
        conditions.push("kind = ?");
        params.push(q.kind);
      }
      if (q.since) {
        conditions.push("timestamp >= ?");
        params.push(q.since);
      }
      if (q.tags && q.tags.length > 0) {
        const tagConditions = q.tags.map(() => "tags LIKE ?");
        conditions.push(`(${tagConditions.join(" OR ")})`);
        for (const tag of q.tags) params.push(`%${JSON.stringify(tag).slice(1, -1)}%`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const limit = q.limit ? `LIMIT ${Math.floor(q.limit)}` : "";
      const sql = `SELECT * FROM observations ${where} ORDER BY timestamp DESC ${limit}`;

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Row[];
      return ok(rows.map((r) => this._rowToObject(r)));
    } catch (cause) {
      return err(
        new Error(
          `SqliteAdapter query failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  async stats(): Promise<Result<MemoryStats, Error>> {
    try {
      const countStmt = this.db.prepare("SELECT COUNT(*) as cnt FROM observations");
      const countRow = countStmt.get() as { cnt: number };
      const lastStmt = this.db.prepare(
        "SELECT timestamp FROM observations ORDER BY timestamp DESC LIMIT 1",
      );
      const lastRow = lastStmt.get() as { timestamp: string } | undefined;
      return ok({
        totalObjects: countRow.cnt,
        lastWrite: lastRow?.timestamp ?? "never",
      });
    } catch (cause) {
      return err(
        new Error(
          `SqliteAdapter stats failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  writeRun(run: {
    runId: string;
    taskId: string;
    description: string;
    language: string;
    taskFamily?: string;
    mode: string;
    model: string;
    providerKey: string;
    providerType: string;
    baseUrl?: string;
    outcome: string;
    outcomeClass: string;
    routingLesson: string;
    finalVerdict: string;
    sourceOfTruth: string;
    finalAction: string;
    tokens: number;
    durationMs: number;
    turns: number;
    validatorDurationMs: number;
    verifierOverall?: string;
    filesEmitted: number;
    totalBytesEmitted: number;
    emissionIds: string[];
    timestamp: string;
  }): void {
    this._stmtInsertRun.run(
      run.runId,
      run.taskId,
      run.description,
      run.language,
      run.taskFamily ?? null,
      run.mode,
      run.model,
      run.providerKey,
      run.providerType,
      run.baseUrl ?? null,
      run.outcome,
      run.outcomeClass,
      run.routingLesson,
      run.finalVerdict,
      run.sourceOfTruth,
      run.finalAction,
      run.tokens,
      run.durationMs,
      run.turns,
      run.validatorDurationMs,
      run.verifierOverall ?? null,
      run.filesEmitted,
      run.totalBytesEmitted,
      JSON.stringify(run.emissionIds ?? []),
      run.timestamp,
    );
  }

  writeEmission(emission: {
    id: string;
    runId: string;
    taskId: string;
    turn: number;
    path: string;
    sha256: string;
    bytes: number;
    beforeHash: string | null;
    existed: boolean;
    timestamp: string;
  }): void {
    this._stmtInsertEmission.run(
      emission.id,
      emission.runId,
      emission.taskId,
      emission.turn,
      emission.path,
      emission.sha256,
      emission.bytes,
      emission.beforeHash,
      emission.existed ? 1 : 0,
      emission.timestamp,
    );
  }

  queryRuns(limit = 50): Array<Record<string, unknown>> {
    const stmt = this.db.prepare("SELECT * FROM runs ORDER BY timestamp DESC LIMIT ?");
    return stmt.all(limit) as Array<Record<string, unknown>>;
  }

  writeRunAndEmissions(
    run: {
      runId: string;
      taskId: string;
      description: string;
      language: string;
      taskFamily?: string;
      mode: string;
      model: string;
      providerKey: string;
      providerType: string;
      baseUrl?: string;
      outcome: string;
      outcomeClass: string;
      routingLesson: string;
      finalVerdict: string;
      sourceOfTruth: string;
      finalAction: string;
      tokens: number;
      durationMs: number;
      turns: number;
      validatorDurationMs: number;
      verifierOverall?: string;
      filesEmitted: number;
      totalBytesEmitted: number;
      emissionIds: string[];
      timestamp: string;
    },
    emissions: Array<{
      id: string;
      runId: string;
      taskId: string;
      turn: number;
      path: string;
      sha256: string;
      bytes: number;
      beforeHash: string | null;
      existed: boolean;
      timestamp: string;
    }>,
  ): void {
    this._stmtBeginTx.run();
    try {
      // Remove stale emissions from a prior write of the same run
      this._stmtDeleteEmissionsByRun.run(run.runId);
      for (const emission of emissions) {
        this.writeEmission(emission);
      }
      this.writeRun(run);
      this._stmtCommit.run();
    } catch (e) {
      try {
        this._stmtRollback.run();
      } catch {
        /* best-effort */
      }
      throw e;
    }
  }

  queryEmissionsForRun(runId: string): Array<Record<string, unknown>> {
    const stmt = this.db.prepare("SELECT * FROM emissions WHERE run_id = ? ORDER BY path");
    return stmt.all(runId) as Array<Record<string, unknown>>;
  }

  async persist(): Promise<void> {
    // WAL checkpoint to flush to disk
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  schemaVersion(): number | null {
    try {
      const row = this.db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as
        | { v: number | null }
        | undefined;
      return row?.v ?? null;
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }

  private _rowToObject(row: Row): MemoryObject {
    return {
      id: row.id as string,
      kind: row.kind as string,
      taskId: row.task_id as string,
      timestamp: row.timestamp as string,
      description: row.description as string,
      properties: JSON.parse(row.properties as string),
      tags: JSON.parse(row.tags as string),
    };
  }
}

interface Row {
  id: string;
  kind: string;
  task_id: string;
  timestamp: string;
  description: string;
  properties: string;
  tags: string;
  [key: string]: unknown;
}
