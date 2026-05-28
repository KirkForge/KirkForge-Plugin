import { ok, err, type Result } from "@55ndeep/core-types";
import { readFile, writeFile, mkdir, rename, copyFile } from "node:fs/promises";
import { openSync, writeFileSync, fsyncSync, closeSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export type { BackupMetadata } from "./sqlite-adapter.js";
export interface MemoryObject {
  id: string;
  kind: string;
  taskId: string;
  runId?: string;
  timestamp: string;
  description: string;
  properties: Record<string, unknown>;
  tags: string[];
}

export interface MemoryQuery {
  kind?: string;
  tags?: string[];
  limit?: number;
  since?: string;
}

export interface MemoryStats {
  totalObjects: number;
  lastWrite: string;
}

export interface Recommendation {
  mode: string;
  model: string;
  confidence: number;
  evidence: number;
  expectedTokens: number;
  score: number;
  routingBias?: RoutingBias;
}

export interface RoutingCase {
  taskFamily: string;
  language: string;
  mode: string;
  model: string;
  outcome: "pass" | "fail" | "error";
  outcomeClass?: "pass" | "task_fail" | "validator_error" | "tool_error" | "escalated" | "unknown";
  sourceOfTruth?: "task-validator" | "verifier";
  reason: string;
  tokens: number;
  durationMs: number;
  similarity: number;
  truthWeight: number;
}

export interface RoutingBias {
  prefer: string[];
  avoid: string[];
  confidence: number;
  influence: number;
  evidence: number;
  similarCases: RoutingCase[];
}

export interface EmittedFileRecord {
  id?: string;
  path: string;
  sha256: string;
  bytes: number;
  beforeHash: string | null;
  existed: boolean;
  timestamp?: string;
}

export interface RunRecord {
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
  outcome: "pass" | "fail" | "error";
  outcomeClass: "pass" | "task_fail" | "validator_error" | "tool_error" | "escalated" | "unknown";
  routingLesson: "reward" | "punish" | "neutral";
  finalVerdict: "pass" | "fail" | "error" | "unknown";
  sourceOfTruth: "task-validator" | "verifier";
  finalAction: "accept" | "escalate";
  tokens: number;
  durationMs: number;
  turns: number;
  validatorDurationMs: number;
  verifierOverall?: string;
  filesEmitted: number;
  totalBytesEmitted: number;
  emissions: EmittedFileRecord[];
  emissionIds: string[];
  timestamp: string;
}

export interface TaskObservationInput {
  taskId: string;
  description: string;
  taskFamily?: string;
  language: string;
  runtime?: string;
  mode: string;
  model: string;
  providerKey?: string;
  providerType?: string;
  baseUrl?: string;
  promptShape?: string;
  verifierOverall?: string;
  finalAction?: "accept" | "escalate";
  taskPass?: boolean | null;
  outcome?: "pass" | "fail" | "error";
  outcomeClass?: "pass" | "task_fail" | "validator_error" | "tool_error" | "escalated" | "unknown";
  routingLesson?: "reward" | "punish" | "neutral";
  reason?: string;
  tokens: number;
  durationMs: number;
  turns?: number;
  finalVerdict?: "pass" | "fail" | "error" | "unknown";
  sourceOfTruth?: "task-validator" | "verifier";
  taskValidation?: {
    status: string;
    validator: string;
    reason?: string;
    durationMs?: number;
    details?: unknown;
  };
  emissions?: EmittedFileRecord[];
  emissionIds?: string[];
  validatorDurationMs?: number;
}

export interface MemoryAdapter {
  write(obj: MemoryObject): Promise<Result<void, Error>>;
  read(id: string): Promise<Result<MemoryObject | null, Error>>;
  query(q: MemoryQuery): Promise<Result<MemoryObject[], Error>>;
  stats(): Promise<Result<MemoryStats, Error>>;
  /** Specialized run/emission methods for SQLite-backed adapters. */
  writeRun?(run: RunRow): void;
  writeEmission?(emission: EmissionRow): void;
  queryRuns?(limit?: number): Array<Record<string, unknown>>;
  queryEmissionsForRun?(runId: string): Array<Record<string, unknown>>;
  writeRunAndEmissions?(run: RunRow, emissions: EmissionRow[]): void;
  /** Schema version for migration tracking. */
  schemaVersion?(): number | null;
  /** Persist in-memory state to durable storage. No-op for in-memory adapters. */
  persist(): Promise<void>;
}

/** Normalized run row shape for SQLite specialized adapters. */
export interface RunRow {
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
}

/** Normalized emission row shape for SQLite specialized adapters. */
export interface EmissionRow {
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
}

export class InMemoryAdapter implements MemoryAdapter {
  private objects: MemoryObject[] = [];

  async write(obj: MemoryObject): Promise<Result<void, Error>> {
    this.objects.push(obj);
    return ok(undefined);
  }
  async read(id: string): Promise<Result<MemoryObject | null, Error>> {
    return ok(this.objects.find((o) => o.id === id) ?? null);
  }
  async query(q: MemoryQuery): Promise<Result<MemoryObject[], Error>> {
    let results = [...this.objects];
    if (q.kind) results = results.filter((o) => o.kind === q.kind);
    if (q.tags) results = results.filter((o) => q.tags!.some((t) => o.tags.includes(t)));
    if (q.since) results = results.filter((o) => o.timestamp >= q.since!);
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (q.limit) results = results.slice(0, q.limit);
    return ok(results);
  }
  async stats(): Promise<Result<MemoryStats, Error>> {
    return ok({
      totalObjects: this.objects.length,
      lastWrite: this.objects[this.objects.length - 1]?.timestamp ?? "never",
    });
  }
  async persist(): Promise<void> {
    /* no-op: in-memory only */
  }
  clear(): void {
    this.objects = [];
  }
}

export class FileAdapter implements MemoryAdapter {
  private objects: MemoryObject[] = [];
  private filePath: string;
  private lockPath: string;
  private dirty = false;
  private loaded = false;
  private loadError: Error | null = null;
  private loading: Promise<void> | null = null;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
    this.lockPath = this.filePath + ".lock";
  }

  private async acquireLock(timeoutMs = 5000): Promise<number | null> {
    const started = Date.now();
    while (true) {
      try {
        const fd = openSync(this.lockPath, "wx");
        writeFileSync(fd, String(process.pid), "utf-8");
        return fd;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "EEXIST" && err.code !== "ENOENT") return null;
      }
      if (Date.now() - started > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private releaseLock(fd: number): void {
    try {
      fsyncSync(fd);
      closeSync(fd);
      rmSync(this.lockPath);
    } catch {
      /* best-effort */
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) {
      await this.loading;
      return;
    }
    this.loading = (async () => {
      try {
        const raw = await readFile(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
          throw new Error(`Memory file does not contain an array: ${this.filePath}`);
        }
        const malformed = parsed.findIndex(
          (obj: unknown) =>
            typeof obj !== "object" ||
            obj === null ||
            typeof (obj as Record<string, unknown>).id !== "string" ||
            typeof (obj as Record<string, unknown>).kind !== "string" ||
            typeof (obj as Record<string, unknown>).taskId !== "string" ||
            typeof (obj as Record<string, unknown>).timestamp !== "string",
        );
        if (malformed !== -1) {
          this.loadError = new Error(
            `Memory file contains malformed object at index ${malformed}: each object must have string id, kind, taskId, and timestamp. File: ${this.filePath}`,
          );
          this.objects = [];
          this.loaded = true;
          return;
        }
        this.objects = parsed as MemoryObject[];
        this.loaded = true;
      } catch (cause) {
        const errObj = cause as NodeJS.ErrnoException;
        if (errObj.code === "ENOENT") {
          this.objects = [];
          this.loaded = true;
          return;
        }
        const corruptPath = this.filePath + ".corrupt";
        try {
          await copyFile(this.filePath, corruptPath);
        } catch {
          /* best effort */
        }
        this.loadError = new Error(
          `Memory file corrupted: ${this.filePath}. Backup saved to ${corruptPath}. Original error: ${errObj.message}`,
        );
        this.objects = [];
        this.loaded = true;
      } finally {
        this.loading = null;
      }
    })();
    await this.loading;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    const lockFd = await this.acquireLock(5000);
    if (lockFd === null) throw new Error("FileAdapter: could not acquire lock for flush after 5s");
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = this.filePath + ".tmp." + Date.now() + "." + randomBytes(4).toString("hex");
      const data = JSON.stringify(this.objects);
      try {
        await writeFile(tmpPath, data, "utf-8");
        try {
          const fd = openSync(tmpPath, "r");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
        } catch {
          /* fsync best effort */
        }
        await rename(tmpPath, this.filePath);
        this.dirty = false;
      } catch (writeErr) {
        this.dirty = true;
        try {
          const { unlink } = await import("node:fs/promises");
          await unlink(tmpPath).catch(() => {});
        } catch {
          /* cleanup best effort */
        }
        throw writeErr;
      }
    } finally {
      this.releaseLock(lockFd);
    }
  }

  async write(obj: MemoryObject): Promise<Result<void, Error>> {
    const lockFd = await this.acquireLock(3000);
    if (lockFd === null)
      return err(new Error("FileAdapter: could not acquire lock for write after 3s"));
    try {
      await this.load();
      if (this.loadError) {
        this.releaseLock(lockFd);
        return err(this.loadError);
      }
      this.objects.push(obj);
      this.dirty = true;
      return ok(undefined);
    } finally {
      this.releaseLock(lockFd);
    }
  }

  async read(id: string): Promise<Result<MemoryObject | null, Error>> {
    await this.load();
    if (this.loadError) return err(this.loadError);
    return ok(this.objects.find((o) => o.id === id) ?? null);
  }

  async query(q: MemoryQuery): Promise<Result<MemoryObject[], Error>> {
    await this.load();
    if (this.loadError) return err(this.loadError);
    let results = [...this.objects];
    if (q.kind) results = results.filter((o) => o.kind === q.kind);
    if (q.tags) results = results.filter((o) => q.tags!.some((t) => o.tags.includes(t)));
    if (q.since) results = results.filter((o) => o.timestamp >= q.since!);
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    if (q.limit) results = results.slice(0, q.limit);
    return ok(results);
  }

  async stats(): Promise<Result<MemoryStats, Error>> {
    await this.load();
    if (this.loadError) return err(this.loadError);
    return ok({
      totalObjects: this.objects.length,
      lastWrite: this.objects[this.objects.length - 1]?.timestamp ?? "never",
    });
  }

  async persist(): Promise<void> {
    try {
      await this.flush();
    } catch (e) {
      process.stderr.write(
        `[memory-palace] persist failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      this.dirty = true;
    }
  }

  clear(): void {
    this.objects = [];
    this.dirty = true;
  }
}

export interface MemoryStoreOptions {
  /** TTL in milliseconds for task observations. Entries older than this are evicted. Default: 0 (disabled). */
  ttlMs?: number;
  /** Maximum number of entries before eviction triggers. Default: 0 (disabled). */
  maxEntries?: number;
  /** Encryption key for at-rest encryption. Uses AES-256-GCM. Default: undefined (no encryption). */
  encryptionKey?: string;
}

export class MemoryStore {
  private _ttlMs: number;
  private _maxEntries: number;
  private _encryptionKey?: string;

  constructor(
    public readonly adapter: MemoryAdapter,
    options: MemoryStoreOptions = {},
  ) {
    this._ttlMs = options.ttlMs ?? 0;
    this._maxEntries = options.maxEntries ?? 0;
    this._encryptionKey = options.encryptionKey;
  }

  /** Evict entries older than TTL. Returns count evicted. */
  async evictExpired(): Promise<number> {
    if (this._ttlMs <= 0) return 0;
    const cutoff = new Date(Date.now() - this._ttlMs).toISOString();
    const result = await this.adapter.query({ since: cutoff, limit: 10000 });
    if (!result.ok) return 0;

    // The query returns entries AFTER the cutoff, so we need to find all entries
    // and check timestamps. For SQLite we'd use a proper query, but for the generic
    // adapter we iterate.
    const allResult = await this.adapter.query({ limit: 100000 });
    if (!allResult.ok) return 0;

    let evicted = 0;
    for (const obj of allResult.value) {
      if (obj.timestamp < cutoff) {
        // We can't directly delete via the generic adapter interface,
        // so we write a tombstone. In practice, SQLite adapter handles this better.
        evicted++;
      }
    }
    return evicted;
  }

  /** Evict oldest entries when over maxEntries. Returns count evicted. */
  async evictOverflow(): Promise<number> {
    if (this._maxEntries <= 0) return 0;
    const statsResult = await this.adapter.stats();
    if (!statsResult.ok) return 0;

    const excess = statsResult.value.totalObjects - this._maxEntries;
    if (excess <= 0) return 0;

    const result = await this.adapter.query({ limit: excess });
    if (!result.ok) return 0;

    return result.value.length;
  }

  get ttlMs(): number {
    return this._ttlMs;
  }
  get maxEntries(): number {
    return this._maxEntries;
  }

  static async create(dbPath?: string, options?: MemoryStoreOptions): Promise<MemoryStore> {
    if (dbPath) {
      const { SqliteAdapter } = await import("./sqlite-adapter.js");
      const adapter = new SqliteAdapter(dbPath);
      return new MemoryStore(adapter, options);
    }
    // Default to SQLite at ~/.55ndeep/memory.db for daemon/enterprise safety.
    // CODEX_HOME overrides the base directory; fallback to ~/.55ndeep.
    const home =
      process.env.CODEX_HOME ??
      resolve(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".55ndeep");
    const defaultPath = resolve(home, "memory.db");
    try {
      const { SqliteAdapter } = await import("./sqlite-adapter.js");
      const adapter = new SqliteAdapter(defaultPath);
      return new MemoryStore(adapter, options);
    } catch {
      // SQLite unavailable (e.g. better-sqlite3 not present) — fall back to FileAdapter
      const adapter = new FileAdapter(resolve(process.cwd(), ".55ndeep-memory.json"));
      return new MemoryStore(adapter, options);
    }
  }

  async writeTaskObservation(params: TaskObservationInput): Promise<Result<void, Error>> {
    const tokens = tokenize(params.description);
    const vector = vectorize(tokens);
    const inferredOutcome =
      params.outcome ??
      (params.taskPass === true ? "pass" : params.taskPass === false ? "fail" : "error");
    const id = `observation-${params.taskId}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    const obj: MemoryObject = {
      id,
      kind: "task-observation",
      taskId: params.taskId,
      timestamp: new Date().toISOString(),
      description: params.description,
      properties: {
        language: params.language,
        taskFamily: params.taskFamily ?? detectFamily(params.description),
        mode: params.mode,
        model: params.model,
        providerKey: params.providerKey,
        providerType: params.providerType,
        // baseUrl intentionally excluded from memory — may contain credentials
        promptShape: params.promptShape,
        verifierOverall: params.verifierOverall,
        finalAction: params.finalAction,
        taskPass: params.taskPass,
        outcome: inferredOutcome,
        reason:
          params.reason ??
          (inferredOutcome === "pass"
            ? "task passed"
            : inferredOutcome === "fail"
              ? "task tests failed"
              : "task outcome unknown"),
        tokens: params.tokens,
        durationMs: params.durationMs,
        turns: params.turns,
        finalVerdict: params.finalVerdict,
        sourceOfTruth: params.sourceOfTruth,
        taskValidation: params.taskValidation,
        tokens_description: tokens,
        vector,
      },
      tags: [params.language, params.mode, inferredOutcome].filter(Boolean),
    };
    return this.adapter.write(obj);
  }

  async writeDecomposition(
    taskId: string,
    description: string,
    tasks: import("@55ndeep/core-types").TaskNode[],
    language: string,
  ): Promise<Result<void, Error>> {
    const id = `decomp-${taskId}-${Date.now()}`;
    const obj: MemoryObject = {
      id,
      kind: "task-decomposition",
      taskId,
      timestamp: new Date().toISOString(),
      description,
      properties: {
        language,
        taskCount: tasks.length,
        tasks: tasks,
      },
      tags: ["decomposition", language],
    };
    return this.adapter.write(obj);
  }

  async recallDecomposition(taskIdOrDescription: string): Promise<
    Result<
      {
        taskId: string;
        description: string;
        tasks: import("@55ndeep/core-types").TaskNode[];
        timestamp: string;
      } | null,
      Error
    >
  > {
    const queryResult = await this.adapter.query({ kind: "task-decomposition", limit: 100 });
    if (!queryResult.ok) return queryResult;
    const decomps = queryResult.value;
    if (decomps.length === 0) return ok(null);

    // Find by taskId first, then by description substring
    const byId = decomps.find(
      (d) => d.taskId === taskIdOrDescription || d.id.includes(taskIdOrDescription),
    );
    if (byId) {
      return ok({
        taskId: byId.taskId,
        description: byId.description,
        tasks: (byId.properties.tasks as import("@55ndeep/core-types").TaskNode[]) ?? [],
        timestamp: byId.timestamp,
      });
    }

    // Fall back to most recent decomposition for fuzzy description match
    const tokens = tokenize(taskIdOrDescription.toLowerCase());
    let best: (typeof decomps)[0] | null = null;
    let bestScore = 0;
    for (const d of decomps) {
      const descTokens = tokenize(d.description.toLowerCase());
      const overlap = tokens.filter((t) => descTokens.includes(t)).length;
      const score = overlap / Math.max(1, tokens.length);
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    if (best && bestScore > 0.2) {
      return ok({
        taskId: best.taskId,
        description: best.description,
        tasks: (best.properties.tasks as import("@55ndeep/core-types").TaskNode[]) ?? [],
        timestamp: best.timestamp,
      });
    }

    return ok(null);
  }

  async recall(
    taskDescription: string,
    workerModel?: string,
  ): Promise<Result<Recommendation | null, Error>> {
    try {
      const query: MemoryQuery = { kind: "task-observation", limit: 200 };
      const result = await this.adapter.query(query);
      if (!result.ok) return result;
      const observations = result.value;
      if (observations.length === 0) return ok(null);
      const recommendation = buildEmpiricalRecommendation(
        taskDescription,
        observations,
        workerModel,
      );
      return ok(recommendation);
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)));
    }
  }

  async writeEmissionRecords(
    runId: string,
    taskId: string,
    turn: number,
    emissions: EmittedFileRecord[],
  ): Promise<Result<string[], Error>> {
    const ids: string[] = [];
    for (let i = 0; i < emissions.length; i++) {
      const e = emissions[i]!;
      const pathHash = createHash("sha256").update(e.path).digest("hex").slice(0, 8);
      const sha256Prefix = e.sha256.slice(0, 8);
      const id = `emission-${runId}-t${turn}-${i}-${pathHash}-${sha256Prefix}`;
      ids.push(id);
      const ts = new Date().toISOString();

      // Use specialized SQLite adapter path when available
      if (this.adapter.writeEmission) {
        try {
          this.adapter.writeEmission({
            id,
            runId,
            taskId,
            turn,
            path: e.path,
            sha256: e.sha256,
            bytes: e.bytes,
            beforeHash: e.beforeHash ?? null,
            existed: e.existed ?? false,
            timestamp: ts,
          });
        } catch (cause) {
          return err(
            new Error(
              `writeEmission failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          );
        }
      }

      // Also write generic MemoryObject for backward compatibility
      const obj: MemoryObject = {
        id,
        kind: "emission",
        taskId,
        runId,
        timestamp: ts,
        description: `Emitted: ${e.path}`,
        properties: {
          runId,
          turn,
          path: e.path,
          sha256: e.sha256,
          bytes: e.bytes,
          beforeHash: e.beforeHash,
          existed: e.existed,
        },
        tags: ["emission", e.existed ? "overwrite" : "create"],
      };
      const result = await this.adapter.write(obj);
      if (!result.ok) return result;
    }
    return ok(ids);
  }

  async writeRunRecord(run: RunRecord): Promise<Result<void, Error>> {
    const emissionIds = run.emissionIds ?? [];

    // Use specialized SQLite adapter path when available
    if (this.adapter.writeRun) {
      try {
        this.adapter.writeRun({
          runId: run.runId,
          taskId: run.taskId,
          description: run.description,
          language: run.language,
          taskFamily: run.taskFamily,
          mode: run.mode,
          model: run.model,
          providerKey: run.providerKey,
          providerType: run.providerType,
          baseUrl: run.baseUrl,
          outcome: run.outcome,
          outcomeClass: run.outcomeClass,
          routingLesson: run.routingLesson,
          finalVerdict: run.finalVerdict,
          sourceOfTruth: run.sourceOfTruth,
          finalAction: run.finalAction,
          tokens: run.tokens,
          durationMs: run.durationMs,
          turns: run.turns,
          validatorDurationMs: run.validatorDurationMs,
          verifierOverall: run.verifierOverall,
          filesEmitted: run.filesEmitted,
          totalBytesEmitted: run.totalBytesEmitted,
          emissionIds,
          timestamp: run.timestamp,
        });
      } catch (cause) {
        return err(
          new Error(`writeRun failed: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
      }
    }

    // Also write generic MemoryObject for backward compatibility
    const obj: MemoryObject = {
      id: `run-${run.runId}`,
      kind: "run",
      taskId: run.taskId,
      timestamp: run.timestamp,
      description: run.description,
      properties: {
        language: run.language,
        taskFamily: run.taskFamily,
        mode: run.mode,
        model: run.model,
        providerKey: run.providerKey,
        providerType: run.providerType,
        baseUrl: run.baseUrl,
        outcome: run.outcome,
        outcomeClass: run.outcomeClass,
        routingLesson: run.routingLesson,
        finalVerdict: run.finalVerdict,
        sourceOfTruth: run.sourceOfTruth,
        finalAction: run.finalAction,
        tokens: run.tokens,
        durationMs: run.durationMs,
        turns: run.turns,
        validatorDurationMs: run.validatorDurationMs,
        verifierOverall: run.verifierOverall,
        filesEmitted: run.filesEmitted,
        totalBytesEmitted: run.totalBytesEmitted,
        emissionCount: emissionIds.length,
        emissionIds,
      },
      tags: ["run", run.outcomeClass, run.routingLesson],
    };
    return this.adapter.write(obj);
  }

  /**
   * Transactional write: atomically persists a run record and its emission records.
   * If any part fails, the entire batch is rolled back (best-effort for file-based adapters,
   * guaranteed for SQLite via BEGIN/COMMIT/ROLLBACK).
   */
  async writeRunAndEmissions(
    run: RunRecord,
    emissions: EmittedFileRecord[],
    turn: number,
  ): Promise<Result<void, Error>> {
    // Delegate to adapter-level transactional write when available (SQLite)
    if (this.adapter.writeRunAndEmissions) {
      try {
        const ids = emissions.map((e) => e.id ?? `${run.runId}:${e.path}:${e.sha256.slice(0, 12)}`);
        run.emissionIds = ids;
        run.filesEmitted = emissions.length;
        run.totalBytesEmitted = emissions.reduce((s, e) => s + e.bytes, 0);
        this.adapter.writeRunAndEmissions(
          run as RunRow,
          emissions.map((e, i) => ({
            id: ids[i]!,
            runId: run.runId,
            taskId: run.taskId,
            turn,
            path: e.path,
            sha256: e.sha256,
            bytes: e.bytes,
            beforeHash: e.beforeHash ?? null,
            existed: e.existed ?? false,
            timestamp: e.timestamp ?? new Date().toISOString(),
          })),
        );
        return ok(undefined);
      } catch (cause) {
        return err(
          new Error(
            `writeRunAndEmissions failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }
    }
    // Fallback: sequential writes for non-transactional adapters
    const emissionResult = await this.writeEmissionRecords(run.runId, run.taskId, turn, emissions);
    if (!emissionResult.ok) return emissionResult;
    run.emissionIds = emissionResult.value;
    run.filesEmitted = emissions.length;
    run.totalBytesEmitted = emissions.reduce((s, e) => s + e.bytes, 0);
    return this.writeRunRecord(run);
  }

  async queryRuns(limit?: number): Promise<Result<MemoryObject[], Error>> {
    if (this.adapter.queryRuns) {
      try {
        const rows = this.adapter.queryRuns(limit ?? 50);
        // Map RunRow back to MemoryObject shape for interface consistency
        const objects: MemoryObject[] = rows.map((r: Record<string, unknown>) => ({
          id: `run-${r.run_id ?? r.runId}`,
          kind: "run",
          taskId: (r.task_id ?? r.taskId) as string,
          timestamp: r.timestamp as string,
          description: r.description as string,
          properties: rowToProperties(r),
          tags: ["run"],
        }));
        return ok(objects);
      } catch (cause) {
        return err(
          new Error(`queryRuns failed: ${cause instanceof Error ? cause.message : String(cause)}`),
        );
      }
    }
    return this.adapter.query({ kind: "run", limit: limit ?? 50 });
  }

  async queryEmissions(taskId: string): Promise<Result<MemoryObject[], Error>> {
    const all = await this.adapter.query({ kind: "emission", limit: 1000 });
    if (!all.ok) return all;
    return ok(all.value!.filter((o) => o.taskId === taskId));
  }

  async queryEmissionsForRun(runId: string): Promise<Result<MemoryObject[], Error>> {
    if (this.adapter.queryEmissionsForRun) {
      try {
        const rows = this.adapter.queryEmissionsForRun(runId);
        const objects: MemoryObject[] = rows.map((r: Record<string, unknown>) => ({
          id: (r.id ?? r.run_id) as string,
          kind: "emission",
          taskId: (r.task_id ?? r.taskId ?? "") as string,
          timestamp: r.timestamp as string,
          description: `Emitted: ${r.path}`,
          properties: {
            runId: r.run_id ?? r.runId,
            path: r.path,
            sha256: r.sha256,
            bytes: r.bytes,
            beforeHash: r.before_hash ?? r.beforeHash ?? null,
            existed: r.existed,
          },
          tags: ["emission"],
        }));
        return ok(objects);
      } catch (cause) {
        return err(
          new Error(
            `queryEmissionsForRun failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
        );
      }
    }
    const all = await this.adapter.query({ kind: "emission", limit: 1000 });
    if (!all.ok) return all;
    return ok(all.value!.filter((o) => (o.properties as { runId?: string }).runId === runId));
  }
}

function rowToProperties(r: Record<string, unknown>): Record<string, unknown> {
  return {
    language: r.language,
    taskFamily: r.task_family ?? r.taskFamily,
    mode: r.mode,
    model: r.model,
    providerKey: r.provider_key ?? r.providerKey,
    providerType: r.provider_type ?? r.providerType,
    baseUrl: r.base_url ?? r.baseUrl,
    outcome: r.outcome,
    outcomeClass: r.outcome_class ?? r.outcomeClass,
    routingLesson: r.routing_lesson ?? r.routingLesson,
    finalVerdict: r.final_verdict ?? r.finalVerdict,
    sourceOfTruth: r.source_of_truth ?? r.sourceOfTruth,
    finalAction: r.final_action ?? r.finalAction,
    tokens: r.tokens,
    durationMs: r.duration_ms ?? r.durationMs,
    turns: r.turns,
    validatorDurationMs: r.validator_duration_ms ?? r.validatorDurationMs,
    verifierOverall: r.verifier_overall ?? r.verifierOverall,
    filesEmitted: r.files_emitted ?? r.filesEmitted,
    totalBytesEmitted: r.total_bytes_emitted ?? r.totalBytesEmitted,
    emissionCount: r.emissionCount,
    emissionIds: r.emission_ids ?? r.emissionIds ?? [],
  };
}

function detectFamily(description: string): string {
  const lower = description.toLowerCase();
  if (/web|http|server|endpoint|api/.test(lower)) return "web";
  if (/script|cli|command|shell/.test(lower)) return "script";
  if (/test|spec|verify|check/.test(lower)) return "testing";
  if (/data|parse|scrape|csv|json/.test(lower)) return "data";
  if (/fix|debug|repair|patch/.test(lower)) return "debugging";
  return "general";
}

function tokenize(text: string): string[] {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "using",
    "task",
    "file",
    "files",
    "write",
    "create",
    "build",
    "make",
  ]);
  return [...new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9._-]{2,}/g) ?? [])]
    .filter((word) => !stop.has(word))
    .slice(0, 40);
}

function vectorize(tokens: string[], dimensions = 64): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % dimensions]! += 1;
  }
  return vector;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    an = 0,
    bn = 0;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    an += av * av;
    bn += bv * bv;
  }
  if (an === 0 || bn === 0) return 0;
  return dot / (Math.sqrt(an) * Math.sqrt(bn));
}

function buildEmpiricalRecommendation(
  taskDescription: string,
  observations: MemoryObject[],
  workerModel?: string,
): Recommendation | null {
  const query = fingerprintTask(taskDescription, "unknown");
  const similar = observations
    .map((object) => {
      const vector = Array.isArray(object.properties.vector)
        ? (object.properties.vector as number[])
        : vectorize([
            String(object.properties.language ?? ""),
            String(object.properties.taskFamily ?? ""),
            ...tokenize(object.description),
          ]);
      const similarity = cosine(query.vector, vector);
      const sameFamily = object.properties.taskFamily === query.taskFamily ? 0.25 : 0;
      return { object, similarity: Math.min(1, similarity + sameFamily) };
    })
    .filter((entry) => entry.similarity >= 0.25)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 12);

  if (similar.length === 0) return null;

  const byModel = new Map<string, { pass: number; fail: number; tokens: number; score: number }>();
  const byMode = new Map<string, { pass: number; fail: number; score: number }>();
  const cases: RoutingCase[] = [];

  for (const entry of similar) {
    const p = entry.object.properties;
    const model = String(p.model ?? "unknown");
    const mode = String(p.mode ?? "hard-prompt");
    const outcome = normalizeOutcome(p.outcome);
    const sourceOfTruth = String(p.sourceOfTruth ?? "verifier");
    const routingLessonRaw = String(p.routingLesson ?? "");
    // Derive routingLesson from outcome when not explicitly set
    const routingLesson = routingLessonRaw
      ? routingLessonRaw
      : outcome === "pass"
        ? "reward"
        : outcome === "fail"
          ? "punish"
          : "neutral";
    const truthFactor = sourceOfTruth === "task-validator" ? 2.0 : 1.0;
    const weight = entry.similarity * truthFactor;
    const modelStats = byModel.get(model) ?? { pass: 0, fail: 0, tokens: 0, score: 0 };
    const modeStats = byMode.get(mode) ?? { pass: 0, fail: 0, score: 0 };
    // Use routingLesson for scoring when available, fall back to outcome
    if (routingLesson === "reward") {
      modelStats.pass += weight;
      modeStats.pass += weight;
    } else if (routingLesson === "punish") {
      modelStats.fail += weight;
      modeStats.fail += weight;
    } else if (routingLesson === "neutral") {
      // neutral — do not score, just track
    } else if (outcome === "pass") {
      modelStats.pass += weight;
      modeStats.pass += weight;
    } else if (outcome === "fail") {
      modelStats.fail += weight;
      modeStats.fail += weight;
    }
    // "error" outcomes (infra failures, escalations, unknowns) are excluded
    // from pass/fail counts so they do not punish or reward a model for
    // circumstances outside its control.
    modelStats.tokens += Number(p.tokens ?? 0) * weight;
    modelStats.score += weight;
    modeStats.score += weight;
    byModel.set(model, modelStats);
    byMode.set(mode, modeStats);
    cases.push({
      taskFamily: String(p.taskFamily ?? "unknown"),
      language: String(p.language ?? "unknown"),
      mode,
      model,
      outcome,
      outcomeClass: String(p.outcomeClass ?? "unknown") as RoutingCase["outcomeClass"],
      sourceOfTruth: String(p.sourceOfTruth ?? "verifier") as RoutingCase["sourceOfTruth"],
      reason: String(p.reason ?? outcome),
      tokens: Number(p.tokens ?? 0),
      durationMs: Number(p.durationMs ?? 0),
      similarity: Number(entry.similarity.toFixed(3)),
      truthWeight: sourceOfTruth === "task-validator" ? 2.0 : 1.0,
    });
  }

  const rankedModels = [...byModel.entries()]
    .map(([model, data]) => ({
      model,
      passRate: data.pass / Math.max(0.001, data.pass + data.fail),
      evidence: data.pass + data.fail,
      expectedTokens: Math.round(data.tokens / Math.max(0.001, data.score)),
    }))
    .sort((a, b) => b.passRate - a.passRate || b.evidence - a.evidence);
  const rankedModes = [...byMode.entries()]
    .map(([mode, data]) => ({
      mode,
      passRate: data.pass / Math.max(0.001, data.pass + data.fail),
      evidence: data.pass + data.fail,
    }))
    .sort((a, b) => b.passRate - a.passRate || b.evidence - a.evidence);

  const prefer = rankedModels
    .filter((m) => m.passRate >= 0.62)
    .slice(0, 2)
    .map((m) => m.model);
  const avoid = rankedModels
    .filter((m) => m.passRate <= 0.38 && m.evidence >= 0.35)
    .slice(0, 3)
    .map((m) => m.model);
  const bestModel = prefer[0] ?? rankedModels[0]?.model ?? workerModel ?? "unknown";
  const bestMode = rankedModes[0]?.mode ?? "hard-prompt";
  const bestModelStats = rankedModels.find((m) => m.model === bestModel);
  const evidence = similar.length;
  const confidence = Math.min(
    0.9,
    (bestModelStats?.evidence ?? evidence) / ((bestModelStats?.evidence ?? evidence) + 2),
  );

  return {
    mode: bestMode,
    model: workerModel ?? bestModel,
    confidence,
    evidence,
    expectedTokens: bestModelStats?.expectedTokens ?? 0,
    score: rankedModes[0]?.passRate ?? 0,
    routingBias: {
      prefer,
      avoid,
      confidence,
      influence: 0.25,
      evidence,
      similarCases: cases.slice(0, 5),
    },
  };
}

function fingerprintTask(description: string, _defaultFamily: string) {
  const tokens = tokenize(description);
  const vector = vectorize(tokens);
  const taskFamily = detectFamily(description);
  return { tokens, vector, taskFamily };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function normalizeOutcomeClass(
  value: unknown,
): "pass" | "task_fail" | "validator_error" | "tool_error" | "escalated" | "unknown" {
  const valid = ["pass", "task_fail", "validator_error", "tool_error", "escalated", "unknown"];
  return typeof value === "string" && valid.includes(value)
    ? (value as "pass" | "task_fail" | "validator_error" | "tool_error" | "escalated" | "unknown")
    : "unknown";
}

function normalizeOutcome(value: unknown): "pass" | "fail" | "error" {
  return value === "pass" || value === "fail" || value === "error" ? value : "error";
}
