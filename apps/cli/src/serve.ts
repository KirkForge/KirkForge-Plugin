import { HealthServer } from "@55ndeep/orchestrator/health-server";
import type { Orchestrator } from "@55ndeep/orchestrator";
import { enterpriseStartupGate, type EnterpriseConfig } from "@55ndeep/core-enterprise";
import { PolicyEngine } from "@55ndeep/core-policy";
import { createAuditSink, AuditLogger, MemoryAuditSink } from "@55ndeep/core-events";
import type { EventBus } from "@55ndeep/core-events";
import type { Logger } from "@55ndeep/core-logging";
import { type OidcConfig } from "@55ndeep/core-rbac";
import { EventLogger } from "@55ndeep/orchestrator/event-log";

export interface ServeOptions {
  orchestrator: Orchestrator;
  eventBus: EventBus;
  logger?: Logger;
}

/**
 * Start the daemon with health-check HTTP server.
 * In enterprise mode, validates all required controls before starting.
 * In dev mode, logs warnings and continues.
 */
export async function startDaemon(opts: ServeOptions): Promise<void> {
  const log = opts.logger ?? console;

  // ── Enterprise mode gate ──────────────────────────────────────────────
  // This is the critical control: if ENTERPRISE_MODE=1, the system MUST
  // fail to start unless auth, audit, policy, and durable storage are
  // configured. No silent fallback to dev behavior.
  let enterpriseConfig: EnterpriseConfig;
  try {
    const gateLogger = {
      info: (m: string) =>
        typeof log === "object" && "info" in log ? (log as any).info(m) : console.log(m),
      warn: (m: string) =>
        typeof log === "object" && "warn" in log ? (log as any).warn(m) : console.warn(m),
      error: (m: string) =>
        typeof log === "object" && "error" in log ? (log as any).error(m) : console.error(m),
    };
    enterpriseConfig = enterpriseStartupGate(gateLogger);
  } catch (err) {
    if (err instanceof Error) {
      console.error(`[serve] Enterprise mode validation failed: ${err.message}`);
      console.error("[serve] Fix the above issues or run without ENTERPRISE_MODE=1 for dev mode.");
      process.exit(1);
    }
    throw err;
  }

  // ── Policy engine ────────────────────────────────────────────────────
  const policyEngine = new PolicyEngine();
  const policyFilePath = process.env.POLICY_FILE_PATH ?? process.env["55NDEEP_POLICY_FILE"];
  if (policyFilePath) {
    const result = policyEngine.loadFromFile(policyFilePath);
    if (!result.ok) {
      console.error(`[serve] Failed to load policy file: ${result.error.message}`);
      if (enterpriseConfig.enabled) {
        process.exit(1);
      }
    } else {
      console.log(`[serve] Policy loaded from ${policyFilePath} (hash: ${policyEngine.getHash()})`);
    }
  } else if (enterpriseConfig.enabled) {
    console.error("[serve] Enterprise mode requires a policy file (POLICY_FILE_PATH not set)");
    process.exit(1);
  }

  // ── Audit logger ──────────────────────────────────────────────────────
  let auditLogger: AuditLogger;
  const auditSinkType = process.env.AUDIT_SINK_TYPE ?? process.env["55NDEEP_AUDIT_SINK"] ?? "none";

  if (auditSinkType === "file") {
    const filePath = process.env.AUDIT_FILE_PATH ?? "/var/lib/55ndeep/audit/audit.jsonl";
    const sink = createAuditSink({ type: "file", filePath });
    auditLogger = new AuditLogger(sink);
    console.log(`[serve] Audit sink: file (${filePath})`);
  } else if (auditSinkType === "http") {
    const httpUrl = process.env.AUDIT_HTTP_URL;
    if (!httpUrl) {
      console.error("[serve] AUDIT_HTTP_URL is required for HTTP audit sink");
      process.exit(1);
    }
    const sink = createAuditSink({ type: "http", httpUrl });
    auditLogger = new AuditLogger(sink);
    console.log(`[serve] Audit sink: HTTP (${httpUrl})`);
  } else if (auditSinkType === "memory") {
    const sink = new MemoryAuditSink();
    auditLogger = new AuditLogger(sink);
    console.warn("[serve] Audit sink: in-memory (NOT durable — do not use in production)");
  } else {
    const sink = new MemoryAuditSink();
    auditLogger = new AuditLogger(sink);
    if (enterpriseConfig.enabled) {
      console.error(
        "[serve] Enterprise mode requires a durable audit sink (AUDIT_SINK_TYPE=file or http)",
      );
      process.exit(1);
    }
    console.warn("[serve] No audit sink configured. Using in-memory (ephemeral) audit.");
  }

  // ── Record startup audit event ────────────────────────────────────────
  await auditLogger.record({
    action: "system.startup",
    outcome: "success",
    actorId: "system",
    tenantId: "",
    reason: enterpriseConfig.enabled ? "Enterprise mode startup" : "Dev mode startup",
    policyHash: policyEngine.getHash(),
  });

  // ── OIDC configuration (from enterprise config) ────────────────────────
  let oidcConfig: OidcConfig | undefined;
  if (enterpriseConfig.auth.oidcIssuer && enterpriseConfig.auth.oidcAudience) {
    oidcConfig = {
      issuer: enterpriseConfig.auth.oidcIssuer,
      audience: enterpriseConfig.auth.oidcAudience,
    };
    console.log(`[serve] OIDC auth configured: issuer=${enterpriseConfig.auth.oidcIssuer}`);
  }

  // ── Group-to-role mapping (from env) ──────────────────────────────────
  const groupRoleMapping = parseGroupRoleMapping(process.env.OIDC_GROUP_ROLE_MAP);

  // ── Health server with RBAC + policy ──────────────────────────────────
  const healthServer = new HealthServer(opts.orchestrator, {
    apiKey: process.env.HEALTH_API_KEY ?? undefined,
    oidcConfig,
    groupRoleMapping,
    auditLogger,
    policyEngine,
  });

  // Wire event audit log if HMAC secret is configured
  const eventLogSecret = process.env.EVENT_LOG_HMAC_SECRET;
  if (eventLogSecret) {
    new EventLogger(opts.eventBus, eventLogSecret);
    console.log("[serve] Event audit log enabled (HMAC-signed)");
  }

  // ── Wire policy deny audit events ──────────────────────────────────
  // Policy engine deny decisions from the orchestrator are already logged
  // via the _auditPolicyDeny helper. The event bus wiring above is for
  // any additional policy enforcement hooks that may be added later.

  await healthServer.start();
  healthServer.ready = true;
  console.log("[serve] 55NDeep daemon ready — health server listening");

  const gracefulStop = async () => {
    console.log("\n[serve] Shutting down...");
    healthServer.ready = false;
    await auditLogger.record({
      action: "system.shutdown",
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
function parseGroupRoleMapping(
  envValue: string | undefined,
): import("@55ndeep/core-rbac").GroupRoleMapping | undefined {
  if (!envValue) return undefined;
  const mapping: import("@55ndeep/core-rbac").GroupRoleMapping = {};
  for (const pair of envValue.split(",")) {
    const [role, group] = pair.split(":").map((s) => s.trim());
    if (role && group) {
      mapping[group] = role as import("@55ndeep/core-rbac").Role;
    }
  }
  return Object.keys(mapping).length > 0 ? mapping : undefined;
}
