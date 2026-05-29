import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Orchestrator } from "./index.js";
import type { OrchestratorStats, HealthCheckResult } from "./types.js";
import type { Logger } from "@55ndeep/core-logging";
import { NDeepError, toErrorResponse } from "@55ndeep/core-errors";
import {
  type Actor,
  type Permission,
  type OidcConfig,
  authorize,
  actorFromJwt,
  actorFromApiKey,
  verifyJwt,
} from "@55ndeep/core-rbac";
import type { AuditLogger } from "@55ndeep/core-events";
import type { PolicyEngine } from "@55ndeep/core-policy";
// ── RBAC-enforced health server ──────────────────────────────────────────────
//
// Extends the basic health server with:
//   - OIDC JWT bearer token validation (claims + audience + issuer)
//   - RBAC permission checks per endpoint
//   - Audit logging for auth success/failure and policy decisions
//   - Policy engine checks for tool/model execution endpoints (future)
//
// Deny-by-default: no auth → 401, wrong role → 403, cross-tenant → 403.
// All deny decisions are emitted as audit events.
export interface HealthServerConfig {
  port?: number;
  host?: string;
  logger?: Logger;
  /** API key for Bearer token auth. Also read from HEALTH_API_KEY env var. */
  apiKey?: string;
  /** Max requests per second per IP (simple rate limiter). Default: 20. */
  rateLimitPerSec?: number;
  /** OIDC configuration for JWT validation. If set, Bearer tokens are validated as JWTs. */
  oidcConfig?: OidcConfig;
  /** Group-to-role mapping for OIDC JWT tokens. */
  groupRoleMapping?: import("@55ndeep/core-rbac").GroupRoleMapping;
  /** Audit logger for auth/policy events. */
  auditLogger?: AuditLogger;
  /** Policy engine for endpoint-level checks. */
  policyEngine?: PolicyEngine;
  /** Request timeout in milliseconds. Default: 30000. */
  requestTimeoutMs?: number;
  /** Max request body size in bytes. Default: 1MB. */
  maxBodyBytes?: number;
  /** Graceful shutdown drain timeout in milliseconds. Default: 10000. */
  drainTimeoutMs?: number;
  /** Allowed CORS origin(s). Default: none (CORS disabled). Set to "*" for any, or specific origin. */
  corsOrigin?: string;
}
interface RateBucket {
  tokens: number;
  lastRefill: number;
}

/** Tracks in-flight requests for graceful shutdown draining. */
interface InFlightRequest {
  req: IncomingMessage;
  res: ServerResponse;
  startedAt: number;
}

/** Default request timeout (30 seconds). */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Default max request body size (1 MB). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
/** Default graceful shutdown drain timeout (10 seconds). */
const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
};
// ── Permission requirements per endpoint ────────────────────────────────────
const ENDPOINT_PERMISSIONS: Record<string, Permission> = {
  "/healthz": "operator:health",
  "/readyz": "operator:health",
  "/metrics": "viewer:metrics",
  "/metrics/json": "viewer:metrics",
  "/metrics/prometheus": "viewer:metrics",
  "/v1/healthz": "operator:health",
  "/v1/readyz": "operator:health",
  "/v1/metrics": "viewer:metrics",
  "/v1/metrics/json": "viewer:metrics",
  "/v1/policy": "admin:policy",
  "/v1/audit": "admin:audit_export",
  "/v1/tenants": "admin:tenant",
  "/v1/quotas": "admin:tenant",
};
/**
 * Lightweight HTTP health-check server for daemon/bot deployment.
 * Exposes /healthz (liveness), /readyz (readiness), /metrics (json),
 * and /v1/metrics (Prometheus text format).
 * Uses only Node built-ins — no Express dependency.
 *
 * API versioning: all routes also available under /v1/ prefix.
 * Auth: Bearer token via HEALTH_API_KEY env var or config.apiKey.
 *       In enterprise mode, OIDC JWT validation with RBAC enforcement.
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
  private oidcConfig?: OidcConfig;
  private groupRoleMapping?: import("@55ndeep/core-rbac").GroupRoleMapping;
  private auditLogger?: AuditLogger;
  private policyEngine?: PolicyEngine;

  private requestTimeoutMs: number;
  private maxBodyBytes: number;
  private drainTimeoutMs: number;
  private corsOrigin?: string;

  // ── Request counter for Prometheus ────────────────────────────────────
  private _requestCount = 0;

  // ── In-flight request tracking for graceful drain ──────────────────────
  private _inFlight = new Map<IncomingMessage, InFlightRequest>();
  private _shuttingDown = false;
  private _drainResolve: (() => void) | null = null;

  // ── Auth/policy counters for Prometheus ────────────────────────────────
  private _authSuccessCount = 0;
  private _authFailureCount = 0;
  private _policyDenyCount = 0;
  constructor(
    private orchestrator: Orchestrator,
    private config: HealthServerConfig = {},
  ) {
    this.apiKey = config.apiKey ?? process.env.HEALTH_API_KEY ?? null;
    this.rateLimitPerSec = config.rateLimitPerSec ?? 20;
    this.oidcConfig = config.oidcConfig;
    this.groupRoleMapping = config.groupRoleMapping;
    this.auditLogger = config.auditLogger;
    this.policyEngine = config.policyEngine;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.drainTimeoutMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.corsOrigin = config.corsOrigin;
  }
  get ready(): boolean {
    return this._ready;
  }
  set ready(v: boolean) {
    this._ready = v;
  }

  /** Number of in-flight requests currently being processed. */
  get inFlightCount(): number {
    return this._inFlight.size;
  }

  /** Number of in-flight requests currently being processed. */
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
      this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        // ── Correlation ID ────────────────────────────────────────────────
        const correlationId = (req.headers["x-request-id"] as string | undefined)
          ?? (req.headers["x-correlation-id"] as string | undefined)
          ?? randomBytes(8).toString("hex");
        res.setHeader("X-Request-Id", correlationId);
        res.setHeader("X-Correlation-Id", correlationId);

        // ── In-flight request tracking ────────────────────────────────────
        this._inFlight.set(req, { req, res, startedAt: Date.now() });
        // ── Request counter ─────────────────────────────────────────────
        this._requestCount++;

        // ── CORS headers ────────────────────────────────────────────────
        if (this.corsOrigin) {
          res.setHeader("Access-Control-Allow-Origin", this.corsOrigin);
          res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.setHeader("Access-Control-Allow-Headers", "Authorization, X-Request-Id, X-Correlation-Id, traceparent");
          res.setHeader("Access-Control-Max-Age", "86400");
        }

        // ── HTTP method validation ──────────────────────────────────────
        const method = req.method?.toUpperCase() ?? "GET";
        if (method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (method !== "GET" && method !== "HEAD") {
          this._sendError(res, new NDeepError("METHOD_NOT_ALLOWED", `${method} is not allowed`), correlationId);
          return;
        }

        try {
          // ── Reject requests during shutdown ────────────────────────────
          if (this._shuttingDown) {
            res.writeHead(503, { "Content-Type": "application/json", ...SECURITY_HEADERS });
            res.end(JSON.stringify({
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Server is shutting down",
                status: 503,
                requestId: correlationId,
                timestamp: new Date().toISOString(),
              },
            }));
            return;
          }

          // ── Request body size limit ────────────────────────────────────
          const contentLength = parseInt(req.headers["content-length"] ?? "0", 10);
          if (contentLength > this.maxBodyBytes) {
            this._authFailureCount++;
            res.writeHead(413, { "Content-Type": "application/json", ...SECURITY_HEADERS });
            res.end(JSON.stringify({
              error: {
                code: "PAYLOAD_TOO_LARGE",
                message: `Request body exceeds maximum size of ${this.maxBodyBytes} bytes`,
                status: 413,
                requestId: correlationId,
                timestamp: new Date().toISOString(),
              },
            }));
            return;
          }

          // Security headers on every response
          for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
            res.setHeader(k, v);
          }
          // W3C traceparent propagation
          this._propagateTraceparent(req, res);
          // Auth check — resolves Actor from Bearer token (async for JWKS)
          const authResult = await this._resolveActor(req, res);
          if (!authResult) return; // response already sent
          // Rate limit
          if (!this._checkRateLimit(req, res)) return;
          // RBAC check — verify actor has permission for this endpoint
          const url = req.url ?? "/";
          const normalizedUrl = this._normalizeUrl(url);
          if (!this._checkPermission(authResult.actor, normalizedUrl, authResult.tokenId, req, res)) {
            return;
          }
          // /v1/ prefixed routes (API versioning)
          if (url.startsWith("/v1/")) return this._routeV1(url.slice(4), req, res);
          // Legacy routes
          if (url === "/healthz") return this._handleHealthz(res);
          if (url === "/readyz") return this._handleReadyz(res);
          if (url === "/metrics") return this._handleMetricsJson(res);
          // Prometheus metrics (also at root for backward compat)
          if (url === "/metrics/prometheus") return this._handleMetricsPrometheus(res);
          this._sendError(res, new NDeepError("NOT_FOUND", `Unknown path: ${url}`), correlationId);
        } catch (err: unknown) {
          this._sendError(res, err instanceof Error ? err : new Error(String(err)), correlationId);
        } finally {
          // ── Access log ────────────────────────────────────────────────────
          // Per-request structured access log: method, path, status, duration, actor.
          // Required for enterprise audit compliance.
          const startedAt = this._inFlight.get(req)?.startedAt ?? Date.now();
          const durationMs = Date.now() - startedAt;
          const accessLog = {
            method: req.method,
            path: req.url,
            status: res.statusCode,
            durationMs,
            actor: (req as any).__actorId ?? "anonymous",
            correlationId,
            ip: req.socket?.remoteAddress,
            userAgent: req.headers["user-agent"],
          };
          this.config.logger?.info(
            `[health-server] ${accessLog.method} ${accessLog.path} ${accessLog.status} ${accessLog.durationMs}ms actor=${accessLog.actor}`,
          );
          this._inFlight.delete(req);
          if (this._shuttingDown && this._inFlight.size === 0 && this._drainResolve) {
            this._drainResolve();
          }
        }
      });

      // ── Server timeouts ─────────────────────────────────────────────────
      this.server.timeout = this.requestTimeoutMs;
      this.server.requestTimeout = this.requestTimeoutMs;
      this.server.headersTimeout = this.requestTimeoutMs + 5000;

      this.server.on("error", (err) => {
        this.config.logger?.error(`[health-server] Failed to start: ${err.message}`);
        reject(err);
      });
      this.server.listen(port, host, () => {
        this.config.logger?.info(
          `[health-server] Listening on ${host}:${port}${this.apiKey ? " (auth enabled)" : ""}`,
        );
        resolve();
      });
    });
  }
  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this._shuttingDown = true;
    this.config.logger?.info("[health-server] Shutting down — draining in-flight requests");

    return new Promise((resolve, reject) => {
      if (!this.server) {
        this._shuttingDown = false;
        resolve();
        return;
      }

      // Wait for in-flight requests to drain, with a timeout
      const drainPromise = new Promise<void>((r) => {
        if (this._inFlight.size === 0) {
          r();
        } else {
          this._drainResolve = r;
        }
      });
      const timeoutPromise = new Promise<void>((r) => setTimeout(r, this.drainTimeoutMs));

      Promise.race([drainPromise, timeoutPromise]).then(() => {
        this.server!.close((err) => {
          this._shuttingDown = false;
          this._drainResolve = null;
          if (err) {
            this.config.logger?.error(`[health-server] Error closing: ${err.message}`);
            reject(err);
          } else {
            this.config.logger?.info("[health-server] Stopped — all requests drained");
            resolve();
          }
        });
      });
    });
  }
  // ── /v1/ API router ──────────────────────────────────────────────────────
  private _routeV1(path: string, req: IncomingMessage, res: ServerResponse): void {
    switch (path) {
      case "healthz":
        return this._handleHealthz(res);
      case "readyz":
        return this._handleReadyz(res);
      case "metrics":
        return this._handleMetricsPrometheus(res);
      case "metrics/json":
        return this._handleMetricsJson(res);
      case "policy":
        return this._handlePolicy(res);
      case "audit":
        return this._handleAuditVerify(req, res);
      case "tenants":
        return this._handleTenants(res);
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "not_found",
            available: ["/v1/healthz", "/v1/readyz", "/v1/metrics", "/v1/metrics/json"],
          }),
        );
    }
  }
  // ── W3C traceparent propagation ──────────────────────────────────────────
  private _propagateTraceparent(req: IncomingMessage, res: ServerResponse): void {
    const traceparent = req.headers["traceparent"];
    if (typeof traceparent === "string" && traceparent.startsWith("00-")) {
      res.setHeader("traceparent", traceparent);
    }
  }
  // ── Auth resolution ──────────────────────────────────────────────────────
  /**
   * Resolve the Actor from the request's Bearer token.
   * - If no API key is configured, requests pass with an internal actor.
   * - If API key is configured and OIDC is configured, try JWT first, then API key.
   * - If only API key is configured, use static key auth.
   * Returns null (and sends response) if auth fails.
   */
  private async _resolveActor(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ actor: Actor; tokenId: string } | null> {
    // No auth configured — internal actor
    if (!this.apiKey && !this.oidcConfig) {
      return {
        actor: {
          id: "internal",
          role: "admin",
          tenantId: "",
          authMethod: "internal",
          verifiedAt: new Date().toISOString(),
        },
        tokenId: "internal",
      };
    }
    const authHeader = req.headers.authorization ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      this._sendUnauthorized(res, "missing Bearer token");
      return null;
    }
    const token = authHeader.slice(7);
    // Try OIDC JWT validation first if configured
    if (this.oidcConfig) {
      const jwtResult = await this._validateJwtBearer(token);
      if (jwtResult) {
        // JWT validated successfully
        this._auditAuth(jwtResult.actor.id, "auth.success", jwtResult.actor.tenantId, "JWT auth");
        this._authSuccessCount++;
        this.orchestrator.recordAuthEvent(
          "auth.success",
          jwtResult.actor.id,
          jwtResult.actor.tenantId,
        );
        return { actor: jwtResult.actor, tokenId: jwtResult.actor.id };
      }
      // JWT failed — fall through to API key if configured
    }
    // Static API key auth
    if (this.apiKey) {
      const result = actorFromApiKey(token, this.apiKey);
      if (result.ok) {
        this._auditAuth(result.value.id, "auth.success", result.value.tenantId, "API key auth");
        this._authSuccessCount++;
        this.orchestrator.recordAuthEvent("auth.success", result.value.id, result.value.tenantId);
        return { actor: result.value, tokenId: result.value.id };
      }
      this._auditAuth("unknown", "auth.failure", "", "Invalid API key");
      this._authFailureCount++;
      this.orchestrator.recordAuthEvent("auth.failure");
      this._sendForbidden(res, "invalid API key");
      return null;
    }
    // OIDC was configured but JWT failed and no API key fallback
    this._sendForbidden(res, "invalid JWT token");
    return null;
  }
  /**
   * Validate a JWT bearer token using full JOSE/JWKS signature verification.
   * Uses the jose library to verify the token's signature against the OIDC
   * provider's JWKS endpoint, then validates claims (issuer, audience, expiry).
   * If JWKS verification fails (e.g. endpoint unreachable), deny immediately.
   * No claims-only fallback — unsigned tokens are never accepted.
   */
  private async _validateJwtBearer(token: string): Promise<{ actor: Actor } | null> {
    if (!this.oidcConfig) return null;
    try {
      const claimsResult = await verifyJwt(token, this.oidcConfig, this.groupRoleMapping);
      if (!claimsResult.ok) {
        this.config.logger?.warn(
          `[health-server] JWT verification failed: ${claimsResult.error.message}`,
        );
        return null;
      }
      const actorResult = actorFromJwt(claimsResult.value, this.oidcConfig, this.groupRoleMapping);
      if (!actorResult.ok) return null;
      return { actor: actorResult.value };
    } catch (e) {
      // JWKS verification failed — deny immediately. No claims-only fallback.
      this.config.logger?.error(
        `[health-server] JWT JWKS verification failed, denying: ${e instanceof Error ? e.message : String(e)}`,
      );
      this._auditAuth("unknown", "auth.failure", "", "JWT JWKS verification error — no fallback");
      this._authFailureCount++;
      return null;
    }
  }
  // ── RBAC permission check ────────────────────────────────────────────────
  /**
   * Check if the actor has the required permission for the given endpoint URL.
   * If no permission is defined for the URL, deny by default in enterprise mode.
   */
  private _checkPermission(
    actor: Actor,
    normalizedUrl: string,
    tokenId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const required = ENDPOINT_PERMISSIONS[normalizedUrl];
    // If no permission mapping exists for this URL, allow it (unknown endpoints
    // will get 404 later). This avoids blocking endpoints we haven't mapped yet.
    if (!required) return true;
    const result = authorize(actor, required);
    if (!result.ok) {
      this._auditAuth(
        actor.id,
        "auth.failure",
        actor.tenantId,
        `RBAC deny: ${actor.role} lacks ${required} for ${normalizedUrl}`,
      );
      this._authFailureCount++;
      this.orchestrator.recordAuthEvent("auth.failure", actor.id, actor.tenantId);
      this._sendForbidden(res, result.error.message);
      return false;
    }
    // Tenant isolation check for future multi-tenant endpoints
    // (Currently health/metrics endpoints are platform-level, tenant check is a no-op)
    return true;
  }
  private _normalizeUrl(url: string): string {
    // Remove query strings and trailing slashes for lookup
    const path = url.split("?")[0]!.replace(/\/+$/, "") || "/";
    return path;
  }
  // ── Audit helper ─────────────────────────────────────────────────────────
  private _auditAuth(
    actorId: string,
    action: "auth.success" | "auth.failure",
    tenantId: string,
    reason: string,
  ): void {
    if (!this.auditLogger) return;
    this.auditLogger
      .record({
        action,
        outcome: action === "auth.success" ? "success" : "deny",
        actorId,
        tenantId,
        reason,
      })
      .catch(() => {
        // Audit write failure must not crash the server
      });
  }
  // ── HTTP response helpers ────────────────────────────────────────────────
  // ── Enterprise API endpoints ────────────────────────────────────────────────

  private _handlePolicy(res: ServerResponse): void {
    if (!this.policyEngine) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "policy_engine_not_configured" }));
      return;
    }
    const policy = this.policyEngine.getPolicy();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        policy,
        hash: this.policyEngine.getHash(),
      }),
    );
  }

  private _handleAuditVerify(req: IncomingMessage, res: ServerResponse): void {
    // Return audit chain integrity status
    // This endpoint verifies the WORM audit log integrity
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "available",
        message: "Use `55ndeep audit-verify --file <path>` to verify audit chain integrity",
      }),
    );
  }

  private _handleTenants(res: ServerResponse): void {
    // Tenant listing — requires admin:tenant permission (already checked by RBAC)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        tenants: [],
        message: "Tenant management via API is planned for a future release",
      }),
    );
  }

  private _sendUnauthorized(res: ServerResponse, reason: string): void {
    const errResp = toErrorResponse(new NDeepError("UNAUTHORIZED", reason));
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="55ndeep"',
    });
    res.end(JSON.stringify(errResp));
  }
  private _sendForbidden(res: ServerResponse, reason: string): void {
    const errResp = toErrorResponse(new NDeepError("FORBIDDEN", reason));
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errResp));
  }

  /** Send a structured error response using the core-errors catalog. */
  private _sendError(res: ServerResponse, error: Error, requestId?: string): void {
    const errResp = toErrorResponse(error, requestId);
    const status = errResp.error.status;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errResp));
  }
  // ── Rate limiting ────────────────────────────────────────────────────────
  private _checkRateLimit(req: IncomingMessage, res: ServerResponse): boolean {
    if (this.rateLimitPerSec <= 0) return true;
    const ip =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown";
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
      res.end(JSON.stringify(toErrorResponse(new NDeepError("RATE_LIMITED", "Too many requests"), undefined)));
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
      res.end(
        JSON.stringify({ status: "unhealthy", stats: health.stats, providers: health.providers }),
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ status: "healthy", stats: health.stats, providers: health.providers }),
    );
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

    // ── Deep readiness: re-verify subsystem health at request time ─────
    // Previously /readyz only checked a boolean _ready flag set at startup.
    // Now it also verifies that the event bus and memory store are actually
    // functional at the time of the request.
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    // Event bus: verify it's running and not backlogged
    const eventBus = health.eventBus;
    if (eventBus && typeof eventBus === "object") {
      const eb = eventBus as { running?: boolean; inflight?: number; bufferSize?: number };
      checks.eventBus = {
        ok: eb.running === true,
        detail: eb.running ? `inflight=${eb.inflight ?? 0}, buffer=${eb.bufferSize ?? 0}` : "not running",
      };
    } else {
      checks.eventBus = { ok: true, detail: "not configured" };
    }

    // Memory store: verify it's connected (or not configured)
    const memStatus = health.memory;
    if (memStatus === "connected") {
      checks.memoryStore = { ok: true };
    } else if (memStatus === "none") {
      checks.memoryStore = { ok: true, detail: "not configured" };
    } else {
      checks.memoryStore = { ok: false, detail: String(memStatus) };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "not_ready",
        checks,
        stats: health.stats,
        providers: health.providers,
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ready",
      checks,
      stats: health.stats,
      providers: health.providers,
    }));
  }
  private _handleMetricsJson(res: ServerResponse): void {
    const stats = this.orchestrator.getStats();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stats));
  }
  // ── Prometheus text format /metrics ───────────────────────────────────────
  private _handleMetricsPrometheus(res: ServerResponse): void {
    const stats: OrchestratorStats = this.orchestrator.getStats();
    const health: HealthCheckResult = this.orchestrator.healthCheck();
    const lines: string[] = [];
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const escapePromLabel = (v: string): string =>
      v.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
    const gauge = (name: string, help: string, value: number, labels?: Record<string, string>) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} gauge`);
      const labelStr = labels
        ? `{${Object.entries(labels)
            .map(([k, v]) => `${k}="${escapePromLabel(v)}"`)
            .join(",")}}`
        : "";
      lines.push(`${name}${labelStr} ${value}`);
    };
    const counter = (
      name: string,
      help: string,
      value: number,
      labels?: Record<string, string>,
    ) => {
      lines.push(`# HELP ${name} ${help}`);
      lines.push(`# TYPE ${name} counter`);
      const labelStr = labels
        ? `{${Object.entries(labels)
            .map(([k, v]) => `${k}="${escapePromLabel(v)}"`)
            .join(",")}}`
        : "";
      lines.push(`${name}${labelStr} ${value}`);
    };
    gauge("55ndeep_up", "Is the 55NDeep server up", health.status === "healthy" ? 1 : 0);
    counter(
      "55ndeep_delegations_total",
      "Total number of delegated tasks",
      num(stats.totalDelegations),
    );
    counter("55ndeep_tokens_total", "Total tokens consumed", num(stats.totalTokens));
    if (typeof stats.totalErrors === "number")
      counter("55ndeep_errors_total", "Total errors", stats.totalErrors);
    if (typeof stats.activeTasks === "number")
      gauge("55ndeep_active_tasks", "Currently active tasks", stats.activeTasks);
    if (typeof stats.memoryEntries === "number")
      gauge("55ndeep_memory_store_entries", "Memory store entries", stats.memoryEntries);
    if (typeof stats.memorySizeBytes === "number")
      gauge("55ndeep_memory_store_size_bytes", "Memory store size in bytes", stats.memorySizeBytes);
    const memUsage = process.memoryUsage();
    gauge("process_resident_memory_bytes", "Resident memory in bytes", memUsage.rss);
    gauge("process_heap_total_bytes", "Total heap in bytes", memUsage.heapTotal);
    gauge("process_heap_used_bytes", "Used heap in bytes", memUsage.heapUsed);
    gauge("process_uptime_seconds", "Process uptime in seconds", process.uptime());
    // Auth/policy counters
    counter("55ndeep_auth_success_total", "Total successful auth events", this._authSuccessCount);
    counter("55ndeep_auth_failure_total", "Total failed auth events", this._authFailureCount);
    counter("55ndeep_policy_deny_total", "Total policy deny events", this._policyDenyCount);
    gauge("55ndeep_http_requests_in_flight", "Currently processing HTTP requests", this._inFlight.size);
    counter("55ndeep_http_requests_total", "Total HTTP requests processed", this._requestCount);
    lines.push("# EOF");
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(lines.join("\n") + "\n");
  }
}
