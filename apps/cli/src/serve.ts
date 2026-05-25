import { HealthServer } from "@55ndeep/orchestrator/health-server";
import type { Orchestrator } from "@55ndeep/orchestrator";
import type { EventBus } from "@55ndeep/core-events";
import type { AuditLogger } from "@55ndeep/core-events";
import type { Logger } from "@55ndeep/core-logging";
import type { PolicyEngine } from "@55ndeep/core-policy";
import type { EnterpriseConfig } from "@55ndeep/core-enterprise";
import type { OidcConfig, GroupRoleMapping, Role } from "@55ndeep/core-rbac";
import { EventLogger } from "@55ndeep/orchestrator/event-log";

export interface ServeOptions {
  orchestrator: Orchestrator;
  eventBus: EventBus;
  logger?: Logger;
  /** Enterprise config from bootstrap. If not provided, dev-mode defaults are used. */
  enterpriseConfig?: EnterpriseConfig;
  /** Policy engine from bootstrap. If not provided, default-deny is used. */
  policyEngine?: PolicyEngine;
  /** Audit logger from bootstrap. If not provided, a no-op logger is used. */
  auditLogger?: AuditLogger;
}

/**
 * Start the daemon with health-check HTTP server.
 * Enterprise controls (enterprise mode gate, policy, audit) are wired in
 * createBootstrap. This function focuses on HTTP server setup and lifecycle.
 */
export async function startDaemon(opts: ServeOptions): Promise<void> {
  const log = opts.logger ?? console;
  const enterpriseConfig = opts.enterpriseConfig ?? {
    enabled: false,
    auth: { configured: false },
    audit: { configured: false, sinkType: "none" as const },
    policy: { configured: false },
    storage: { backend: "memory" as const, durable: false },
    secrets: { providers: ["env"], envOnlyFallback: true },
  };
  const auditLogger =
    opts.auditLogger ??
    ({
      record: async () => true,
      flush: async () => true,
      close: async () => {},
      getSink: () => ({ name: "noop" }),
    } as unknown as AuditLogger);

  if (enterpriseConfig.enabled) {
    log.info?.("[serve] Enterprise mode ENABLED — all controls validated in bootstrap.");
  } else {
    log.info?.("[serve] Running in developer mode.");
  }

  // ── Record serve-specific audit event ─────────────────────────────────
  await auditLogger.record({
    action: "serve.start",
    outcome: "success",
    actorId: "system",
    tenantId: "",
    reason: enterpriseConfig.enabled ? "Enterprise daemon starting" : "Dev daemon starting",
    policyHash: opts.policyEngine?.getHash(),
  });

  // ── OIDC configuration (from enterprise config) ──────────────────────
  let oidcConfig: OidcConfig | undefined;
  if (enterpriseConfig.auth?.oidcIssuer && enterpriseConfig.auth?.oidcAudience) {
    oidcConfig = {
      issuer: enterpriseConfig.auth.oidcIssuer,
      audience: enterpriseConfig.auth.oidcAudience,
    };
    log.info?.(`[serve] OIDC auth configured: issuer=${enterpriseConfig.auth.oidcIssuer}`);
  }

  // ── Group-to-role mapping (from env) ─────────────────────────────────
  const groupRoleMapping = parseGroupRoleMapping(process.env.OIDC_GROUP_ROLE_MAP);

  // ── Health server with RBAC + policy ──────────────────────────────────
  const healthServer = new HealthServer(opts.orchestrator, {
    apiKey: process.env.HEALTH_API_KEY ?? undefined,
    oidcConfig,
    groupRoleMapping,
    auditLogger,
    policyEngine: opts.policyEngine,
  });

  // Wire event audit log if HMAC secret is configured
  const eventLogSecret = process.env.EVENT_LOG_HMAC_SECRET;
  if (eventLogSecret) {
    new EventLogger(opts.eventBus, eventLogSecret);
    log.info?.("[serve] Event audit log enabled (HMAC-signed)");
  }

  await healthServer.start();
  healthServer.ready = true;
  log.info?.("[serve] 55NDeep daemon ready — health server listening");

  const gracefulStop = async () => {
    log.info?.("\n[serve] Shutting down...");
    healthServer.ready = false;
    await auditLogger.record({
      action: "serve.shutdown",
      outcome: "success",
      actorId: "system",
      tenantId: "",
      reason: "SIGTERM received",
    });
    await auditLogger.flush();
    await auditLogger.close();
    await healthServer.stop();
    process.exit(0);
  };

  process.on("SIGTERM", gracefulStop);
  process.on("SIGINT", gracefulStop);
}

/**
 * Parse OIDC_GROUP_ROLE_MAP from env.
 * Format: "admin:admins,operator:operators,developer:developers,viewer:viewers"
 * Maps OIDC group names to 55NDeep roles.
 */
function parseGroupRoleMapping(envValue: string | undefined): GroupRoleMapping | undefined {
  if (!envValue) return undefined;
  const mapping: GroupRoleMapping = {};
  for (const pair of envValue.split(",")) {
    const [role, group] = pair.split(":").map((s) => s.trim());
    if (role && group) {
      mapping[group] = role as Role;
    }
  }
  return Object.keys(mapping).length > 0 ? mapping : undefined;
}
