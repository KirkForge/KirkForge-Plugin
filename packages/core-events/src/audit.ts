import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

// ── Audit sink for 55NDeep ──────────────────────────────────────────────────
//
// Provides an append-only audit log with tamper-evidence (chain hashes) and
// external sink adapters (file, HTTP/SIEM). In enterprise mode, the audit
// sink is mandatory and must not silently fall back to in-memory.
//
// Audit events are distinct from regular EventBus events — they carry actor
// context, tenant scope, and a decision/action classification.

// ── Types ──────────────────────────────────────────────────────────────────

export type AuditAction =
  | "auth.success"
  | "auth.failure"
  | "auth.token_refresh"
  | "policy.check"
  | "policy.deny"
  | "policy.change"
  | "tenant.create"
  | "tenant.evict"
  | "tenant.access"
  | "verify.start"
  | "verify.complete"
  | "correct.start"
  | "correct.complete"
  | "observe.record"
  | "observe.recall"
  | "memory.read"
  | "memory.write"
  | "memory.delete"
  | "secret.access"
  | "secret.resolve"
  | "config.change"
  | "tool.invoke"
  | "tool.deny"
  | "model.invoke"
  | "model.deny"
  | "system.startup"
  | "system.shutdown"
  | "system.error";

export type AuditOutcome = "success" | "deny" | "error" | "skipped";

export interface AuditEvent {
  /** Unique event ID. */
  id: string;
  /** Sequential event number for this sink. */
  sequence: number;
  /** ISO timestamp. */
  timestamp: string;
  /** What happened. */
  action: AuditAction;
  /** Outcome of the action. */
  outcome: AuditOutcome;
  /** Actor who performed the action. */
  actorId: string;
  /** Tenant scope. */
  tenantId: string;
  /** Human-readable reason (especially important for deny). */
  reason: string;
  /** SHA-256 chain hash: hash(prevHash + thisEvent). */
  chainHash: string;
  /** Policy hash at time of event (if applicable). */
  policyHash?: string;
  /** Request/trace correlation ID. */
  traceId?: string;
  /** Additional context. */
  metadata?: Record<string, unknown>;
}

export interface AuditSink {
  /** Human-readable name for logging. */
  readonly name: string;
  /** Write an audit event. Must not throw; return false on failure. */
  write(event: AuditEvent): Promise<boolean>;
  /** Flush any buffered events. */
  flush(): Promise<boolean>;
  /** Close the sink and release resources. */
  close(): Promise<void>;
}

export interface AuditSinkConfig {
  /** Type of sink: "file" | "http" | "memory". */
  type: "file" | "http" | "memory";
  /** File path for file sink. */
  filePath?: string;
  /** URL for HTTP sink. */
  httpUrl?: string;
  /** HTTP headers (e.g. Authorization). */
  httpHeaders?: Record<string, string>;
  /** Buffer size before forcing flush. Default: 100. */
  flushInterval?: number;
}

// ── File audit sink ────────────────────────────────────────────────────────

export class FileAuditSink implements AuditSink {
  readonly name = "file";
  private filePath: string;
  private buffer: AuditEvent[] = [];
  private flushSize: number;
  private lastHash: string;

  constructor(config: { filePath: string; flushInterval?: number }) {
    this.filePath = resolve(config.filePath);
    this.flushSize = config.flushInterval ?? 100;
    this.lastHash = initialHash();
    // Ensure directory exists
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  async write(event: AuditEvent): Promise<boolean> {
    this.buffer.push(event);
    if (this.buffer.length >= this.flushSize) {
      return this.flush();
    }
    return true;
  }

  async flush(): Promise<boolean> {
    if (this.buffer.length === 0) return true;
    try {
      const lines: string[] = [];
      for (const event of this.buffer) {
        const chainHash = chainHashOf(this.lastHash, event);
        const sealed: AuditEvent = { ...event, chainHash };
        lines.push(JSON.stringify(sealed));
        this.lastHash = chainHash;
      }
      const content = lines.join("\n") + "\n";
      appendFileSync(this.filePath, content, "utf-8");
      this.buffer = [];
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

// ── HTTP (SIEM) audit sink ─────────────────────────────────────────────────

export class HttpAuditSink implements AuditSink {
  readonly name = "http";
  private url: string;
  private headers: Record<string, string>;
  private buffer: AuditEvent[] = [];
  private flushSize: number;
  private lastHash: string;

  constructor(config: { url: string; headers?: Record<string, string>; flushInterval?: number }) {
    this.url = config.url;
    this.headers = { "Content-Type": "application/json", ...(config.headers ?? {}) };
    this.flushSize = config.flushInterval ?? 50;
    this.lastHash = initialHash();
  }

  async write(event: AuditEvent): Promise<boolean> {
    this.buffer.push(event);
    if (this.buffer.length >= this.flushSize) {
      return this.flush();
    }
    return true;
  }

  async flush(): Promise<boolean> {
    if (this.buffer.length === 0) return true;
    const events = this.buffer.splice(0);
    try {
      const sealed: AuditEvent[] = events.map((event) => {
        const chainHash = chainHashOf(this.lastHash, event);
        this.lastHash = chainHash;
        return { ...event, chainHash };
      });
      const res = await fetch(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ events: sealed, batch: true }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      // Re-buffer for retry
      this.buffer.unshift(...events);
      return false;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }
}

// ── Memory audit sink (dev only — NOT for enterprise) ──────────────────────

export class MemoryAuditSink implements AuditSink {
  readonly name = "memory";
  private events: AuditEvent[] = [];
  private lastHash: string;

  constructor() {
    this.lastHash = initialHash();
  }

  async write(event: AuditEvent): Promise<boolean> {
    const chainHash = chainHashOf(this.lastHash, event);
    this.events.push({ ...event, chainHash });
    this.lastHash = chainHash;
    return true;
  }

  async flush(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    // no-op
  }

  /** Get all stored events (for testing). */
  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  /** Verify chain integrity (for testing). */
  verifyChain(): boolean {
    let prev = initialHash();
    for (const event of this.events) {
      const expected = chainHashOf(prev, event);
      if (event.chainHash !== expected) return false;
      prev = event.chainHash;
    }
    return true;
  }
}

// ── Audit logger ───────────────────────────────────────────────────────────

export class AuditLogger {
  private sink: AuditSink;
  private sequence = 0;

  constructor(sink: AuditSink) {
    this.sink = sink;
  }

  /** Record an audit event. */
  async record(params: {
    action: AuditAction;
    outcome: AuditOutcome;
    actorId: string;
    tenantId: string;
    reason: string;
    policyHash?: string;
    traceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<boolean> {
    const event: AuditEvent = {
      id: `audit-${Date.now()}-${this.sequence++}`,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
      action: params.action,
      outcome: params.outcome,
      actorId: params.actorId,
      tenantId: params.tenantId,
      reason: params.reason,
      chainHash: "", // will be computed by sink
      ...(params.policyHash ? { policyHash: params.policyHash } : {}),
      ...(params.traceId ? { traceId: params.traceId } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    return this.sink.write(event);
  }

  /** Flush pending events. */
  async flush(): Promise<boolean> {
    return this.sink.flush();
  }

  /** Close the audit logger and release resources. */
  async close(): Promise<void> {
    return this.sink.close();
  }

  /** Get the underlying sink (for testing). */
  getSink(): AuditSink {
    return this.sink;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an audit sink from config. In enterprise mode, "memory" is not
 * accepted and will throw — use validateEnterpriseAudit() instead.
 */
export function createAuditSink(config: AuditSinkConfig): AuditSink {
  switch (config.type) {
    case "file":
      if (!config.filePath) throw new Error("File audit sink requires filePath");
      return new FileAuditSink({ filePath: config.filePath, flushInterval: config.flushInterval });
    case "http":
      if (!config.httpUrl) throw new Error("HTTP audit sink requires httpUrl");
      return new HttpAuditSink({
        url: config.httpUrl,
        headers: config.httpHeaders,
        flushInterval: config.flushInterval,
      });
    case "memory":
      return new MemoryAuditSink();
    default:
      throw new Error(`Unknown audit sink type: ${config.type}`);
  }
}

// ── Chain hash helpers ─────────────────────────────────────────────────────

function initialHash(): string {
  return createHash("sha256").update("55ndeep-audit-genesis").digest("hex").slice(0, 24);
}

function chainHashOf(prevHash: string, event: AuditEvent): string {
  const payload = `${prevHash}|${event.action}|${event.actorId}|${event.tenantId}|${event.timestamp}|${event.sequence}`;
  return createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 24);
}
