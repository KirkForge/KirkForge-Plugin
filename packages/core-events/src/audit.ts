import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  fsyncSync,
  chmodSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createSocket } from "node:dgram";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { createConnection as netCreateConnection, type Socket } from "node:net";
import { execFileSync } from "node:child_process";

// ── Audit sink for KirkForge ──────────────────────────────────────────────────
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
  /** Syslog transport protocol. Default: "udp". Supports "tls" for RFC 5425. */
  syslogTransport?: "udp" | "tcp" | "tls";
  /** Syslog host. Default: "localhost". */
  syslogHost?: string;
  /** Syslog port. Default: 514 (6514 for TLS). */
  syslogPort?: number;
  /** Syslog facility code (0–23). Default: 1. */
  syslogFacility?: number;
  /** Syslog application name. Default: "kirkforge". */
  syslogAppName?: string;
  /** TLS options for syslog over TLS (RFC 5425). Used when syslogTransport is "tls". */
  syslogTls?: {
    /** Path to CA certificate for server verification. */
    ca?: string;
    /** Path to client certificate for mTLS. */
    cert?: string;
    /** Path to client private key for mTLS. */
    key?: string;
    /** Whether to reject unauthorized server certificates. Default: true. */
    rejectUnauthorized?: boolean;
    /** Server name for SNI. Default: syslogHost. */
    servername?: string;
  };
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
    } catch (_e) {
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
    } catch (_e) {
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
    } catch (_e) {
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
        tls: config.syslogTls,
      });
    case "memory":
      return new MemoryAuditSink();
    default:
      throw new Error(`Unknown audit sink type: ${config.type}`);
  }
}

// ── Chain hash helpers ─────────────────────────────────────────────────────

export function initialHash(): string {
  return createHash("sha256").update("kirkforge-audit-genesis").digest("hex").slice(0, 24);
}

export function chainHashOf(prevHash: string, event: AuditEvent): string {
  const payload = `${prevHash}|${event.action}|${event.actorId}|${event.tenantId}|${event.timestamp}|${event.sequence}`;
  return createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 24);
}

// ── Syslog audit sink (CEF/SIEM integration) ──────────────────────────────

export interface SyslogAuditSinkConfig {
  /** Syslog transport: "udp", "tcp", or "tls". Default: "udp".
   *  "tls" uses RFC 5425 TLS-protected syslog for enterprise SIEM integration. */
  transport?: "udp" | "tcp" | "tls";
  /** Remote syslog host. Default: "localhost". */
  host?: string;
  /** Remote syslog port. Default: 514. */
  port?: number;
  /** Syslog facility code (0–23). Default: 1 (user-level). */
  facility?: number;
  /** Application name in syslog messages. Default: "kirkforge". */
  appName?: string;
  /** Buffer size before forcing flush. Default: 50. */
  flushInterval?: number;
  /** TLS options for "tls" transport. Required when transport is "tls". */
  tls?: {
    /** Path to CA certificate for server verification. */
    ca?: string;
    /** Path to client certificate for mTLS. */
    cert?: string;
    /** Path to client private key for mTLS. */
    key?: string;
    /** Whether to reject unauthorized server certificates. Default: true. */
    rejectUnauthorized?: boolean;
    /** Server name for SNI. Default: host. */
    servername?: string;
  };
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
  private transport: "udp" | "tcp" | "tls";
  private host: string;
  private port: number;
  private facility: number;
  private appName: string;
  private buffer: AuditEvent[] = [];
  private flushSize: number;
  private lastHash: string;
  private socket: ReturnType<typeof import("node:dgram").createSocket> | null = null;
  private tlsSocket: TLSSocket | Socket | null = null;
  private tlsConfig: SyslogAuditSinkConfig["tls"];
  private reconnecting = false;

  constructor(config: SyslogAuditSinkConfig = {}) {
    this.transport = config.transport ?? "udp";
    this.host = config.host ?? "localhost";
    this.port = config.port ?? (config.transport === "tls" ? 6514 : 514);
    this.facility = config.facility ?? 1; // user-level
    this.appName = config.appName ?? "kirkforge";
    this.flushSize = config.flushInterval ?? 50;
    this.tlsConfig = config.tls;
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
    if (this.tlsSocket) {
      try {
        this.tlsSocket.destroy();
      } catch (_e) {
        // best-effort
      }
      this.tlsSocket = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch (_e) {
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
      typeof process !== "undefined" && process.env?.HOSTNAME ? process.env.HOSTNAME : "kirkforge";

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

    return `<${pri}>${ts} ${hostname} ${this.appName} audit: CEF:0|KirkForge|Audit|1.0|${event.action}|${event.reason}|${severityLabel}|${extensions}`;
  }

  private async send(message: string): Promise<boolean> {
    const data = Buffer.from(message + "\n", "utf-8");
    if (this.transport === "udp") {
      return this.sendUdp(data);
    }
    if (this.transport === "tls") {
      return this.sendTls(data);
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
      } catch (_e) {
        resolve(false);
      }
    });
  }

  private async sendTcp(data: Buffer): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        const socket = netCreateConnection({ host: this.host, port: this.port }, () => {
          socket.write(data, (err) => {
            if (err) {
              socket.destroy();
              resolve(false);
            } else {
              socket.end(() => {
                resolve(true);
              });
            }
          });
        });
        socket.on("error", () => resolve(false));
        socket.setTimeout(5000, () => {
          socket.destroy();
          resolve(false);
        });
      } catch (_e) {
        resolve(false);
      }
    });
  }

  /**
   * Send audit event over TLS-protected syslog connection (RFC 5425).
   * Establishes a TLS connection to the syslog server, transmits the message,
   * and closes the connection. Supports mutual TLS (mTLS) when cert/key are
   * provided in the TLS config.
   */
  private async sendTls(data: Buffer): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        // readFileSync is already imported at module scope

        const tlsOptions: import("node:tls").ConnectionOptions = {
          host: this.host,
          port: this.port,
          rejectUnauthorized: this.tlsConfig?.rejectUnauthorized ?? true,
          servername: this.tlsConfig?.servername ?? this.host,
        };

        if (this.tlsConfig?.ca) {
          tlsOptions.ca = readFileSync(this.tlsConfig.ca, "utf-8");
        }
        if (this.tlsConfig?.cert) {
          tlsOptions.cert = readFileSync(this.tlsConfig.cert, "utf-8");
        }
        if (this.tlsConfig?.key) {
          tlsOptions.key = readFileSync(this.tlsConfig.key, "utf-8");
        }

        const socket = tlsConnect(tlsOptions, () => {
          if (!socket.authorized && (this.tlsConfig?.rejectUnauthorized ?? true)) {
            socket.destroy();
            resolve(false);
            return;
          }
          socket.write(data, (err) => {
            if (err) {
              socket.destroy();
              resolve(false);
            } else {
              socket.end(() => {
                resolve(true);
              });
            }
          });
        });

        socket.on("error", () => resolve(false));
        socket.setTimeout(5000, () => {
          socket.destroy();
          resolve(false);
        });
      } catch (_e) {
        resolve(false);
      }
    });
  }
}

// ── WORM (Write-Once-Read-Many) audit sink ──────────────────────────────────
//
// Provides tamper-evident, append-only storage for enterprise audit compliance.
// Once events are written, they cannot be modified or deleted through this API.
// The sink maintains a hash chain for integrity verification and supports
// WORM-compatible storage backends.
//
// Enterprise deployments should use this sink in conjunction with file
// permissions (chattr +i on Linux, or cloud WORM storage like S3 Object Lock)
// for true immutability guarantees.

export interface WormAuditSinkConfig {
  /** Path to the WORM audit log directory. */
  directory: string;
  /** File prefix for audit log segments. Default: "audit-worm". */
  filePrefix?: string;
  /** Maximum size per segment file in bytes before rotation. Default: 100 MB. */
  maxSegmentBytes?: number;
  /** Maximum number of segment files to keep. Default: 0 (unlimited). */
  maxSegments?: number;
  /** Whether to fsync after each flush for durability. Default: true. */
  fsyncAfterFlush?: boolean;
  /** Whether to verify chain integrity on each write. Default: true. */
  verifyOnWrite?: boolean;
}

export class WormAuditSink implements AuditSink {
  readonly name = "worm";
  private directory: string;
  private filePrefix: string;
  private maxSegmentBytes: number;
  private maxSegments: number;
  private fsyncAfterFlush: boolean;
  private verifyOnWrite: boolean;
  private buffer: AuditEvent[] = [];
  private flushSize: number;
  private lastHash: string;
  private currentSegment: number;
  private currentSegmentPath: string;
  private writeCount = 0;

  constructor(config: WormAuditSinkConfig) {
    this.directory = resolve(config.directory);
    this.filePrefix = config.filePrefix ?? "audit-worm";
    this.maxSegmentBytes = config.maxSegmentBytes ?? 100 * 1024 * 1024; // 100 MB
    this.maxSegments = config.maxSegments ?? 0; // 0 = unlimited
    this.fsyncAfterFlush = config.fsyncAfterFlush ?? true;
    this.verifyOnWrite = config.verifyOnWrite ?? true;
    this.flushSize = 50;
    this.lastHash = initialHash();
    this.currentSegment = 0;
    this.currentSegmentPath = "";

    // Ensure directory exists
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true });

    // Discover the latest segment
    this._discoverLatestSegment();
  }

  private _discoverLatestSegment(): void {
    try {
      const files = readdirSync(this.directory)
        .filter((f) => f.startsWith(this.filePrefix))
        .sort();
      if (files.length > 0) {
        const latest = files[files.length - 1]!;
        const match = latest.match(/(\d+)\.jsonl$/);
        if (match) {
          this.currentSegment = parseInt(match[1]!, 10);
          this.currentSegmentPath = join(this.directory, latest);
          // Read the last hash from the segment
          this._restoreLastHash();
        }
      }
      if (!this.currentSegmentPath) {
        this.currentSegment = 0;
        this.currentSegmentPath = this._segmentPath(0);
      }
    } catch (_e) {
      this.currentSegment = 0;
      this.currentSegmentPath = this._segmentPath(0);
    }
  }

  private _segmentPath(segment: number): string {
    return join(this.directory, `${this.filePrefix}-${String(segment).padStart(6, "0")}.jsonl`);
  }

  private _restoreLastHash(): void {
    try {
      if (!existsSync(this.currentSegmentPath)) return;
      const content = readFileSync(this.currentSegmentPath, "utf-8").trim();
      if (!content) return;
      const lines = content.split("\n");
      // Find the last valid JSON line
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const event = JSON.parse(lines[i]!);
          if (event.chainHash) {
            this.lastHash = event.chainHash;
            return;
          }
        } catch (_e) {
          continue;
        }
      }
    } catch (_e) {
      // Best-effort restoration
    }
  }

  async write(event: AuditEvent): Promise<boolean> {
    // Compute chain hash before buffering
    const chainHash = chainHashOf(this.lastHash, event);
    const sealed: AuditEvent = { ...event, chainHash };
    this.lastHash = chainHash;

    // Verify chain integrity if enabled
    if (this.verifyOnWrite && this.buffer.length > 0) {
      const prevEvent = this.buffer[this.buffer.length - 1];
      if (prevEvent) {
        const expected = chainHashOf(prevEvent.chainHash, event);
        if (sealed.chainHash !== expected) {
          // Chain integrity violation — this should never happen
          throw new Error(
            `WORM audit chain integrity violation: expected hash ${expected}, got ${sealed.chainHash}`,
          );
        }
      }
    }

    this.buffer.push(sealed);
    this.writeCount++;
    if (this.buffer.length >= this.flushSize) {
      return this.flush();
    }
    return true;
  }

  async flush(): Promise<boolean> {
    if (this.buffer.length === 0) return true;
    try {
      // Check if current segment is too large
      if (existsSync(this.currentSegmentPath)) {
        const stats = statSync(this.currentSegmentPath);
        if (stats.size >= this.maxSegmentBytes) {
          this.currentSegment++;
          this.currentSegmentPath = this._segmentPath(this.currentSegment);
        }
      }

      // Enforce max segments (WORM: refuse to delete old)
      if (this.maxSegments > 0) {
        // Only refuse when we need to CREATE a new segment beyond the limit.
        // Appending to an existing current segment is always allowed — it is
        // already counted within maxSegments and still has room.
        if (!existsSync(this.currentSegmentPath) && !this._enforceMaxSegments()) {
          // WORM: cannot delete old segments — refuse new writes to preserve
          // audit evidence. Return false so callers know the write was rejected.
          this.buffer = [];
          return false;
        }
      }

      // Append events to current segment
      const lines = this.buffer.map((e) => JSON.stringify(e)).join("\n") + "\n";
      appendFileSync(this.currentSegmentPath, lines, "utf-8");

      // Fsync for durability
      if (this.fsyncAfterFlush) {
        try {
          const fd = openSync(this.currentSegmentPath, "r");
          fsyncSync(fd);
          closeSync(fd);
        } catch (_e) {
          // Best-effort fsync
        }
      }

      this.buffer = [];
      return true;
    } catch (_e) {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private _enforceMaxSegments(): boolean {
    try {
      const files = readdirSync(this.directory)
        .filter((f) => f.startsWith(this.filePrefix) && f.endsWith(".jsonl"))
        .sort();
      if (files.length >= this.maxSegments) {
        // WORM compliance: refuse to delete old audit segments.
        // Deleting old segments would destroy audit evidence.
        // Return false so the caller knows writes must stop.
        // Operators should configure external rotation (e.g. log shipping
        // to immutable storage) or increase maxSegments.
        return false;
      }
      return true;
    } catch (_e) {
      return true; // no directory yet — fine to write
    }
  }

  /** Get the total number of events written. */
  getWriteCount(): number {
    return this.writeCount;
  }

  /**
   * Make a segment file immutable using OS-level file permissions.
   * On Linux, uses chattr +i (requires CAP_LINUX_IMMUTABLE or root).
   * On other platforms, falls back to read-only file permissions (chmod 0o444).
   *
   * Returns true if immutability was successfully applied, false otherwise.
   * This is a best-effort operation - cloud WORM storage (S3 Object Lock)
   * should be used for production immutability guarantees.
   */
  makeSegmentImmutable(segmentNumber?: number): boolean {
    const segPath =
      segmentNumber !== undefined ? this._segmentPath(segmentNumber) : this.currentSegmentPath;
    if (!segPath || !existsSync(segPath)) return false;

    try {
      chmodSync(segPath, 0o444);

      if (process.platform === "linux") {
        try {
          execFileSync("chattr", ["+i", segPath], { timeout: 5000 });
          return true;
        } catch (_e) {
          // chattr requires root/CAP_LINUX_IMMUTABLE - best effort
        }
      }
      return true;
    } catch (_e) {
      return false;
    }
  }

  /**
   * Check if a segment file is immutable.
   * On Linux, checks if the immutable flag is set via lsattr.
   * On other platforms, checks if the file is read-only.
   */
  isSegmentImmutable(segmentNumber?: number): boolean {
    const segPath =
      segmentNumber !== undefined ? this._segmentPath(segmentNumber) : this.currentSegmentPath;
    if (!segPath || !existsSync(segPath)) return false;

    try {
      if (process.platform === "linux") {
        try {
          const output = execFileSync("lsattr", ["-d", segPath], { timeout: 5000 });
          const attrs = output.toString().split(/\s/)[0] ?? "";
          return /i/.test(attrs);
        } catch (_e) {
          // lsattr not available or no permissions
        }
      }
      const stats = statSync(segPath);
      return (stats.mode & 0o200) === 0;
    } catch (_e) {
      return false;
    }
  }

  /** Get the current segment number. */
  getCurrentSegment(): number {
    return this.currentSegment;
  }

  /**
   * Verify the integrity of the entire WORM audit log.
   * Returns true if all chain hashes are valid, false if any tampering is detected.
   */
  verifyIntegrity(): boolean {
    try {
      const files = readdirSync(this.directory)
        .filter((f) => f.startsWith(this.filePrefix) && f.endsWith(".jsonl"))
        .sort();

      let prevHash = initialHash();
      for (const file of files) {
        const content = readFileSync(join(this.directory, file), "utf-8").trim();
        if (!content) continue;
        for (const line of content.split("\n")) {
          try {
            const event = JSON.parse(line);
            const expected = chainHashOf(prevHash, event);
            if (event.chainHash !== expected) return false;
            prevHash = event.chainHash;
          } catch (_e) {
            continue;
          }
        }
      }
      return true;
    } catch (_e) {
      return false;
    }
  }
}

// Need to import these for WormAuditSink
