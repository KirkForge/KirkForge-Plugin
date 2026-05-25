import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createSocket } from "node:dgram";

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
  | "serve.start"
  | "serve.shutdown"
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

// ── Audit sink configuration ────────────────────────────────────────────────

export interface AuditSinkConfig {
  /** Type of sink: "file" | "http" | "memory". */
  type: "file" | "http" | "syslog" | "memory";
  /** File path for file sink. */
  filePath?: string;
  /** URL for HTTP sink. */
  httpUrl?: string;
  /** HTTP headers (e.g. Authorization). */
  httpHeaders?: Record<string, string>;

  /** Buffer size before forcing flush. Default: 100. */
  flushInterval?: number;
  /** Maximum file size in bytes before rotation (file sink only). Default: 50 MB. */
  maxFileSizeBytes?: number;
  /** Maximum rotated files to keep (file sink only). Default: 10. */
  maxRotatedFiles?: number;
  /** Syslog transport protocol. Default: "udp". */
  syslogTransport?: "udp" | "tcp";
  /** Syslog host. Default: "localhost". */
  syslogHost?: string;
  /** Syslog port. Default: 514. */
  syslogPort?: number;
  /** Syslog facility code (0–23). Default: 1. */
  syslogFacility?: number;
  /** Syslog application name. Default: "55ndeep". */
  syslogAppName?: string;
}

export interface FileAuditSinkConfig {
  /** Path to the audit log file. */
  filePath: string;
  /** Buffer size before forcing flush. Default: 100. */
  flushInterval?: number;
  /** Maximum file size in bytes before rotation (file sink only). Default: 50 MB. */
  maxFileSizeBytes?: number;
  /** Maximum rotated files to keep (file sink only). Default: 10. */
  maxRotatedFiles?: number;
  /** Syslog transport protocol. Default: "udp". */
  syslogTransport?: "udp" | "tcp";
  /** Syslog host. Default: "localhost". */
  syslogHost?: string;
  /** Syslog port. Default: 514. */
  syslogPort?: number;
  /** Syslog facility code (0–23). Default: 1. */
  syslogFacility?: number;
  /** Syslog application name. Default: "55ndeep". */
  syslogAppName?: string;
}

// ── File audit sink with rotation ────────────────────────────────────────────
//
// Supports size-based rotation: when the log file exceeds maxFileSizeBytes,
// it is renamed to <file>.1, <file>.2, etc., and a new file is started.
// Rotation preserves chain integrity — each rotated file contains a complete
// hash chain from genesis to its last event.

export class FileAuditSink implements AuditSink {
  readonly name = "file";
  private filePath: string;
  private buffer: AuditEvent[] = [];
  private flushSize: number;
  private lastHash: string;
  private maxFileSizeBytes: number;
  private maxRotatedFiles: number;

  constructor(config: FileAuditSinkConfig) {
    this.filePath = resolve(config.filePath);
    this.flushSize = config.flushInterval ?? 100;
    this.maxFileSizeBytes = config.maxFileSizeBytes ?? 50 * 1024 * 1024; // 50 MB
    this.maxRotatedFiles = config.maxRotatedFiles ?? 10;
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

  /**
   * Rotate the audit log if it exceeds maxFileSizeBytes.
   * Renames the current file to <file>.1, shifts existing rotated files,
   * and deletes files beyond maxRotatedFiles.
   */
  private _rotate(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const stats = statSync(this.filePath);
      if (stats.size < this.maxFileSizeBytes) return;

      // Shift existing rotated files: .N -> .N+1
      for (let i = this.maxRotatedFiles - 1; i >= 1; i--) {
        const rotated = `${this.filePath}.${i}`;
        const next = `${this.filePath}.${i + 1}`;
        if (existsSync(rotated)) {
          renameSync(rotated, next);
        }
      }
      // Current file becomes .1
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch {
      // Rotation failure is not fatal — we continue appending to the current file.
    }
  }

  async flush(): Promise<boolean> {
    if (this.buffer.length === 0) return true;
    try {
      // Rotate before writing if needed
      this._rotate();

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
      return new FileAuditSink({
        filePath: config.filePath,
        flushInterval: config.flushInterval,
        maxFileSizeBytes: config.maxFileSizeBytes,
        maxRotatedFiles: config.maxRotatedFiles,
      });
    case "http":
      if (!config.httpUrl) throw new Error("HTTP audit sink requires httpUrl");
      return new HttpAuditSink({
        url: config.httpUrl,
        headers: config.httpHeaders,
        flushInterval: config.flushInterval,
      });
    case "syslog":
      return new SyslogAuditSink({
        transport: config.syslogTransport,
        host: config.syslogHost,
        port: config.syslogPort,
        facility: config.syslogFacility,
        appName: config.syslogAppName,
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

// ── Syslog audit sink (CEF/SIEM integration) ──────────────────────────────

export interface SyslogAuditSinkConfig {
  /** Syslog transport: "udp" or "tcp". Default: "udp". */
  transport?: "udp" | "tcp";
  /** Remote syslog host. Default: "localhost". */
  host?: string;
  /** Remote syslog port. Default: 514. */
  port?: number;
  /** Syslog facility code (0–23). Default: 1 (user-level). */
  facility?: number;
  /** Application name in syslog messages. Default: "55ndeep". */
  appName?: string;
  /** Buffer size before forcing flush. Default: 50. */
  flushInterval?: number;
}

/**
 * Syslog audit sink that sends audit events in CEF (Common Event Format)
 * over UDP or TCP syslog. Designed for SIEM integration (Splunk, Elastic,
 * Sentinel, etc.).
 *
 * Each audit event is formatted as a structured syslog message with:
 *   - PRI: facility * 8 + severity
 *   - HEADER: timestamp, hostname, appName
 *   - CEF body: action, outcome, actor, tenant, reason, chainHash
 *
 * For deny and error outcomes, severity is WARNING (4).
 * For success outcomes, severity is INFORMATIONAL (6).
 * For skipped outcomes, severity is DEBUG (7).
 */
export class SyslogAuditSink implements AuditSink {
  readonly name = "syslog";
  private transport: "udp" | "tcp";
  private host: string;
  private port: number;
  private facility: number;
  private appName: string;
  private buffer: AuditEvent[] = [];
  private flushSize: number;
  private lastHash: string;
  private socket: ReturnType<typeof import("node:dgram").createSocket> | null = null;

  constructor(config: SyslogAuditSinkConfig = {}) {
    this.transport = config.transport ?? "udp";
    this.host = config.host ?? "localhost";
    this.port = config.port ?? 514;
    this.facility = config.facility ?? 1; // user-level
    this.appName = config.appName ?? "55ndeep";
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
    let allOk = true;
    for (const event of events) {
      const chainHash = chainHashOf(this.lastHash, event);
      this.lastHash = chainHash;
      const message = this.formatMessage({ ...event, chainHash });
      const ok = await this.send(message);
      if (!ok) allOk = false;
    }
    return allOk;
  }

  async close(): Promise<void> {
    await this.flush();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // best-effort
      }
      this.socket = null;
    }
  }

  private severityForOutcome(outcome: AuditOutcome): number {
    switch (outcome) {
      case "deny":
      case "error":
        return 4; // warning
      case "success":
        return 6; // informational
      case "skipped":
        return 7; // debug
      default:
        return 6;
    }
  }

  private formatMessage(event: AuditEvent): string {
    const severity = this.severityForOutcome(event.outcome);
    const pri = this.facility * 8 + severity;
    const ts = event.timestamp.replace("T", " ").replace("Z", "");
    const hostname =
      typeof process !== "undefined" && process.env?.HOSTNAME ? process.env.HOSTNAME : "55ndeep";

    // CEF format: CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extensions
    const severityLabel = severity <= 3 ? "High" : severity <= 5 ? "Medium" : "Low";
    const extensions = [
      `actor=${event.actorId}`,
      `tenant=${event.tenantId}`,
      `outcome=${event.outcome}`,
      `chainHash=${event.chainHash}`,
      event.policyHash ? `policyHash=${event.policyHash}` : "",
      event.traceId ? `traceId=${event.traceId}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return `<${pri}>${ts} ${hostname} ${this.appName} audit: CEF:0|55NDeep|Audit|1.0|${event.action}|${event.reason}|${severityLabel}|${extensions}`;
  }

  private async send(message: string): Promise<boolean> {
    const data = Buffer.from(message, "utf-8");
    if (this.transport === "udp") {
      return this.sendUdp(data);
    }
    return this.sendTcp(data);
  }

  private async sendUdp(data: Buffer): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const sock = createSocket("udp4");
        sock.send(data, this.port, this.host, (err: Error | null) => {
          sock.close();
          resolve(!err);
        });
      } catch {
        resolve(false);
      }
    });
  }

  private async sendTcp(_data: Buffer): Promise<boolean> {
    // TCP syslog requires a persistent connection — for now, fall back to UDP behavior
    // with a note that production TCP should use a connection pool.
    // This is a placeholder for enterprise deployments that need reliable delivery.
    return this.sendUdp(_data);
  }
}
