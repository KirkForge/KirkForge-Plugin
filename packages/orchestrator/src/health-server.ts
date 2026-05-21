import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Orchestrator } from "./index.js";
import type { Logger } from "@55ndeep/core-logging";
import { timingSafeEqual } from "node:crypto";

export interface HealthServerConfig {
  port?: number;
  host?: string;
  logger?: Logger;
  /** API key for Bearer token auth. Also read from HEALTH_API_KEY env var. */
  apiKey?: string;
  /** Max requests per second per IP (simple rate limiter). Default 20. */
  rateLimitPerSec?: number;
}

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, no-cache, must-revalidate",
};

/**
 * Lightweight HTTP health-check server for daemon/bot deployment.
 * Exposes /healthz (liveness), /readyz (readiness), /metrics (json),
 * and /v1/metrics (Prometheus text format).
 * Uses only Node built-ins — no Express dependency.
 *
 * API versioning: all routes also available under /v1/ prefix.
 * Auth: Bearer token via HEALTH_API_KEY env var or config.apiKey.
 * Rate limiting: simple token-bucket per IP, configurable via rateLimitPerSec.
 * Tracing: W3C traceparent propagation supported on all responses.
 */
export class HealthServer {
  private server: ReturnType<typeof createServer> | null = null;
  private _ready = false;
  private apiKey: string | null;
  private rateLimitPerSec: number;
  private buckets = new Map<string, RateBucket>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private orchestrator: Orchestrator,
    private config: HealthServerConfig = {},
  ) {
    this.apiKey = config.apiKey ?? process.env.HEALTH_API_KEY ?? null;
    this.rateLimitPerSec = config.rateLimitPerSec ?? 20;
  }

  get ready(): boolean { return this._ready; }
  set ready(v: boolean) { this._ready = v; }

  start(): Promise<void> {
    const port = this.config.port ?? parseInt(process.env.HEALTH_PORT ?? "9090", 10);
    const host = this.config.host ?? process.env.HEALTH_HOST ?? "0.0.0.0";

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.lastRefill > 60000) this.buckets.delete(key);
      }
    }, 30000);

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Security headers on every response
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
          res.setHeader(k, v);
        }

        // W3C traceparent propagation
        this._propagateTraceparent(req, res);

        // Auth check
        if (!this._checkAuth(req, res)) return;

        // Rate limit
        if (!this._checkRateLimit(req, res)) return;

        const url = req.url ?? "/";

        // /v1/ prefixed routes (API versioning)
        if (url.startsWith("/v1/")) return this._routeV1(url.slice(4), req, res);

        // Legacy routes
        if (url === "/healthz") return this._handleHealthz(res);
        if (url === "/readyz") return this._handleReadyz(res);
        if (url === "/metrics") return this._handleMetricsJson(res);

        // Prometheus metrics (also at root for backward compat)
        if (url === "/metrics/prometheus") return this._handleMetricsPrometheus(res);

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });

      this.server.on("error", (err) => {
        this.config.logger?.error(`[health-server] Failed to start: ${err.message}`);
        reject(err);
      });

      this.server.listen(port, host, () => {
        this.config.logger?.info(`[health-server] Listening on ${host}:${port}${this.apiKey ? " (auth enabled)" : ""}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.config.logger?.info("[health-server] Stopped");
        resolve();
      });
    });
  }

  // ── /v1/ API router ──────────────────────────────────────────────────────

  private _routeV1(path: string, req: IncomingMessage, res: ServerResponse): void {
    switch (path) {
      case "healthz": return this._handleHealthz(res);
      case "readyz": return this._handleReadyz(res);
      case "metrics": return this._handleMetricsPrometheus(res);
      case "metrics/json": return this._handleMetricsJson(res);
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found", available: ["/v1/healthz", "/v1/readyz", "/v1/metrics", "/v1/metrics/json"] }));
    }
  }

  // ── W3C traceparent propagation ──────────────────────────────────────────

  private _propagateTraceparent(req: IncomingMessage, res: ServerResponse): void {
    const incoming = req.headers.traceparent as string | undefined;
    if (!incoming) return;

    // Parse: 00-traceId-spanId-01
    const parts = incoming.split("-");
    if (parts.length !== 4 || parts[0] !== "00") return;

    const [version, traceId, spanId, flags] = parts;
    if (!version || !traceId || !spanId || !flags) return;

    // Generate a new span ID for this server-side span
    const newSpanId = Array.from({ length: 16 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join("");

    res.setHeader("traceresponse", `${version}-${traceId}-${newSpanId}-${flags}`);
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private _checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true;

    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", reason: "missing Bearer token" }));
      return false;
    }

    const token = authHeader.slice(7);
    const expected = this.apiKey;

    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", reason: "invalid API key" }));
      return false;
    }

    return true;
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────

  private _checkRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
      ?? req.socket.remoteAddress
      ?? "unknown";

    const now = Date.now();
    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = { tokens: this.rateLimitPerSec, lastRefill: now };
      this.buckets.set(ip, bucket);
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.rateLimitPerSec, bucket.tokens + elapsed * this.rateLimitPerSec);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": "1",
      });
      res.end(JSON.stringify({ error: "rate_limited", retryAfterSec: 1 }));
      return false;
    }

    bucket.tokens -= 1;
    return true;
  }

  // ── Endpoint handlers ─────────────────────────────────────────────────────

  private _handleHealthz(res: ServerResponse): void {
    const health = this.orchestrator.healthCheck();
    if (health.status === "shutting_down") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "unhealthy", stats: health.stats, providers: health.providers }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "healthy", stats: health.stats, providers: health.providers }));
  }

  private _handleReadyz(res: ServerResponse): void {
    if (!this._ready) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_ready" }));
      return;
    }
    const health = this.orchestrator.healthCheck();
    if (health.status === "shutting_down") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "not_ready", reason: "shutting_down" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ready", stats: health.stats, providers: health.providers }));
  }

  private _handleMetricsJson(res: ServerResponse): void {
    const stats = this.orchestrator.getStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
  }

  // ── Prometheus text format /metrics ───────────────────────────────────────

  private _handleMetricsPrometheus(res: ServerResponse): void {
    // Use type assertions since orchestrator stats may extend over time
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stats = this.orchestrator.getStats() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const health = this.orchestrator.healthCheck() as any;

    const lines: string[] = [];
    const num = (v: unknown): number => typeof v === "number" ? v : 0;

    const gauge = (name: string, help: string, value: number, labels?: Record<string, string>) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}` : "";
      lines.push(`${name}${labelStr} ${value}`);
    };

    const counter = (name: string, help: string, value: number, labels?: Record<string, string>) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const labelStr = labels ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}` : "";
      lines.push(`${name}${labelStr} ${value}`);
    };

    gauge("55ndeep_up", "Is the 55NDeep server up", health.status === "healthy" ? 1 : 0);
    counter("55ndeep_delegations_total", "Total number of delegated tasks", num(stats.totalDelegations));
    counter("55ndeep_tokens_total", "Total tokens consumed", num(stats.totalTokens));

    // Extended stats (available in future versions)
    if (typeof stats.totalErrors === "number") counter("55ndeep_errors_total", "Total errors", stats.totalErrors);
    if (typeof stats.activeTasks === "number") gauge("55ndeep_active_tasks", "Currently active tasks", stats.activeTasks);
    if (typeof stats.memoryEntries === "number") gauge("55ndeep_memory_store_entries", "Memory store entries", stats.memoryEntries);
    if (typeof stats.memorySizeBytes === "number") gauge("55ndeep_memory_store_size_bytes", "Memory store size in bytes", stats.memorySizeBytes);

    // Process metrics
    const memUsage = process.memoryUsage();
    gauge("process_resident_memory_bytes", "Resident memory in bytes", memUsage.rss);
    gauge("process_heap_total_bytes", "Total heap in bytes", memUsage.heapTotal);
    gauge("process_heap_used_bytes", "Used heap in bytes", memUsage.heapUsed);
    gauge("process_uptime_seconds", "Process uptime in seconds", process.uptime());

    lines.push("# EOF");

    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(lines.join("\n") + "\n");
  }
}
