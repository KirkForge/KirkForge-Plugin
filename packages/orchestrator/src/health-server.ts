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

/**
 * Lightweight HTTP health-check server for daemon/bot deployment.
 * Exposes /healthz (liveness), /readyz (readiness), and /metrics.
 * Uses only Node built-ins — no Express dependency.
 *
 * Auth: Bearer token via HEALTH_API_KEY env var or config.apiKey.
 * Rate limiting: simple token-bucket per IP, configurable via rateLimitPerSec.
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

    // Periodic cleanup of stale rate-limit buckets
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.lastRefill > 60000) this.buckets.delete(key);
      }
    }, 30000);

    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        // Auth check
        if (!this._checkAuth(req, res)) return;

        // Rate limit
        if (!this._checkRateLimit(req, res)) return;

        if (req.url === "/healthz") return this._handleHealthz(res);
        if (req.url === "/readyz") return this._handleReadyz(res);
        if (req.url === "/metrics") return this._handleMetrics(res);
        res.writeHead(404).end("not found\n");
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

  // ── Auth ──────────────────────────────────────────────────────────────────

  private _checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey) return true; // Auth not configured — allow all

    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", reason: "missing Bearer token" }));
      return false;
    }

    const token = authHeader.slice(7);
    const expected = this.apiKey;

    // Constant-time comparison to prevent timing attacks
    const tokenBuf = Buffer.from(token);
    const expectedBuf = Buffer.from(expected);
    if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden", reason: "invalid API key" }));
      return false;
    }

    return true;
  }

  // ── Rate limiting (token bucket per IP) ──────────────────────────────────

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

    // Refill tokens
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

  private _handleMetrics(res: ServerResponse): void {
    const stats = this.orchestrator.getStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
  }
}
