# Compliance Evidence Pack

This document provides a structured evidence map for enterprise readiness
assessments of 55NDeep. It maps enterprise requirements to implemented
controls, test coverage, and known gaps.

## Evidence Map

### 1. Authentication & Authorization

| Control               | Evidence                                      | Status         | Location                          |
| --------------------- | --------------------------------------------- | -------------- | --------------------------------- |
| OIDC JWT validation   | `verifyJwt` with JWKS, `validateJwtClaims`    | ✅ Implemented | `core-rbac/src/jwt-verify.ts`     |
| API key bearer auth   | `actorFromApiKey` with timing-safe comparison | ✅ Implemented | `core-rbac/src/index.ts`          |
| RBAC deny-by-default  | `authorize()`, `authorizeTenant()`            | ✅ Implemented | `core-rbac/src/index.ts`          |
| Group-to-role mapping | `GroupRoleMapping`, `resolveRole()`           | ✅ Implemented | `core-rbac/src/index.ts`          |
| Auth audit logging    | `AuthAuditHook`, `createAuthAuditHook()`      | ✅ Implemented | `plugin/src/auth-audit-bridge.ts` |
| Auth middleware       | `AuthMiddleware` with OIDC + API key          | ✅ Implemented | `plugin/src/auth-middleware.ts`   |
| Negative auth tests   | Malformed/expired/missing tokens              | ✅ Implemented | `core-rbac/tests/index.test.ts`   |

### 2. Multi-Tenancy

| Control                     | Evidence                                 | Status         | Location                       |
| --------------------------- | ---------------------------------------- | -------------- | ------------------------------ |
| Tenant registry             | `TenantRegistry` with path isolation     | ✅ Implemented | `core-tenancy/src/index.ts`    |
| Path traversal prevention   | `isSafeResourceName()`, `resolvePath()`  | ✅ Implemented | `core-tenancy/src/index.ts`    |
| Tenant-scoped memory        | `createMemoryStore()` per tenant         | ✅ Implemented | `core-tenancy/src/index.ts`    |
| Tenant context threading    | `TenantContext`, `createTenantContext()` | ✅ Implemented | `plugin/src/tenant-context.ts` |
| Tenant audit scoping        | `createTenantAuditLogger()`              | ✅ Implemented | `plugin/src/tenant-context.ts` |
| Cross-tenant access control | `authorizeTenant()`                      | ✅ Implemented | `core-rbac/src/index.ts`       |

### 3. Sandboxed Execution

| Control                    | Evidence                                        | Status         | Location                               |
| -------------------------- | ----------------------------------------------- | -------------- | -------------------------------------- |
| Constraint types           | `SandboxConstraints`, `DEFAULT_CONSTRAINTS`     | ✅ Implemented | `core-sandbox/src/index.ts`            |
| Constraint merging         | `mergeConstraints()` (tenant can only tighten)  | ✅ Implemented | `core-sandbox/src/index.ts`            |
| Path allowlist enforcement | `isReadPathAllowed()`, `isWritePathAllowed()`   | ✅ Implemented | `core-sandbox/src/index.ts`            |
| Command allowlist          | `isCommandAllowed()`                            | ✅ Implemented | `core-sandbox/src/index.ts`            |
| Network allowlist          | `isNetworkDestinationAllowed()`                 | ✅ Implemented | `core-sandbox/src/index.ts`            |
| Process runner             | `runSandboxed()` with timeout, output limits    | ✅ Implemented | `core-sandbox/src/runner.ts`           |
| Docker runner              | `runDockerSandboxed()` with container isolation | ✅ Implemented | `core-sandbox/src/runner.ts`           |
| Path traversal tests       | `../`, `.env`, hidden files blocked             | ✅ Implemented | `core-tenancy/tests/isolation.test.ts` |
| Sandbox escape tests       | Constraint escalation blocked                   | ✅ Implemented | `core-sandbox/tests/index.test.ts`     |

### 4. Policy Engine

| Control                | Evidence                                   | Status         | Location                   |
| ---------------------- | ------------------------------------------ | -------------- | -------------------------- |
| Deny-by-default policy | `PolicyEngine`, `DEFAULT_POLICY`           | ✅ Implemented | `core-policy/src/index.ts` |
| Signed policy bundles  | `verifySignedPolicy()`, `signPolicyHmac()` | ✅ Implemented | `core-policy/src/index.ts` |
| Model allowlist        | `isModelAllowed()`                         | ✅ Implemented | `core-policy/src/index.ts` |
| Tool allowlist         | `isToolAllowed()`                          | ✅ Implemented | `core-policy/src/index.ts` |
| Tenant overrides       | `getEffectivePolicy()`                     | ✅ Implemented | `core-policy/src/index.ts` |

### 5. Audit Trail

| Control                | Evidence                                 | Status         | Location                            |
| ---------------------- | ---------------------------------------- | -------------- | ----------------------------------- |
| Chain-hash integrity   | `chainHashOf()`, `verifyChain()`         | ✅ Implemented | `core-events/src/audit.ts`          |
| File audit sink        | `FileAuditSink` with rotation            | ✅ Implemented | `core-events/src/audit.ts`          |
| WORM audit sink        | `WormAuditSink` with fsync, segment mgmt | ✅ Implemented | `core-events/src/audit.ts`          |
| Syslog/CEF sink        | `SyslogAuditSink`                        | ✅ Implemented | `core-events/src/audit.ts`          |
| HTTP/SIEM sink         | `HttpAuditSink`                          | ✅ Implemented | `core-events/src/audit.ts`          |
| Tamper detection       | `verifyIntegrity()`, chain verification  | ✅ Implemented | `core-events/src/audit.ts`          |
| SIEM integration guide | CEF format, Splunk/Elastic mapping       | ✅ Documented  | `docs/security/siem-integration.md` |

### 6. Enterprise Mode

| Control           | Evidence                              | Status         | Location                        |
| ----------------- | ------------------------------------- | -------------- | ------------------------------- |
| Startup gate      | `enterpriseStartupGate()`             | ✅ Implemented | `core-enterprise/src/index.ts`  |
| Required controls | Auth, audit, policy, storage, secrets | ✅ Implemented | `core-enterprise/src/index.ts`  |
| Per-tenant quotas | `QuotaManager`, `RateLimiter`         | ✅ Implemented | `core-enterprise/src/quotas.ts` |

### 7. Observability

| Control            | Evidence                              | Status         | Location                            |
| ------------------ | ------------------------------------- | -------------- | ----------------------------------- |
| OpenTelemetry      | Collector config + metrics            | ✅ Implemented | `core-telemetry/`                   |
| SLO monitor        | `SloMonitor`, `AuthPolicySloMonitor`  | ✅ Implemented | `orchestrator/src/slo-monitor.ts`   |
| Health server      | `/healthz`, `/readyz`, `/metrics`     | ✅ Implemented | `orchestrator/src/health-server.ts` |
| Prometheus metrics | Auth/policy counters, process metrics | ✅ Implemented | `orchestrator/src/health-server.ts` |

## Known Gaps

| Gap                                                | Severity | Remediation Plan                              |
| -------------------------------------------------- | -------- | --------------------------------------------- |
| Docker sandbox runtime not tested in CI            | Medium   | Add Docker-based integration tests            |
| Ed25519 policy signing not yet production-hardened | Medium   | Complete Ed25519 verification in core-secrets |
| QuotaManager is in-memory only (no persistence)    | Medium   | Add SQLite or Redis persistence               |
| WORM sink file permissions not enforced by code    | Low      | Document OS-level WORM setup (chattr +i)      |
| No formal external security audit yet              | High     | Schedule third-party penetration test         |

## Compliance Controls Mapping

### SOC 2 Type II

| Control                 | 55NDeep Implementation                                |
| ----------------------- | ----------------------------------------------------- |
| CC6.1 Logical Access    | OIDC JWT + API key auth, RBAC, tenant isolation       |
| CC6.2 Authentication    | `verifyJwt`, `actorFromApiKey`, `AuthMiddleware`      |
| CC6.3 Authorization     | `authorize()`, `authorizeTenant()`, `PolicyEngine`    |
| CC7.1 Monitoring        | `AuditLogger`, `SloMonitor`, Prometheus metrics       |
| CC7.2 Incident Response | Incident response runbook, SIEM integration           |
| CC8.1 Change Management | Signed policy bundles, audit trail for config changes |

### ISO 27001

| Control                                | 55NDeep Implementation                                   |
| -------------------------------------- | -------------------------------------------------------- |
| A.9.1.1 Access control policy          | `PolicyEngine` deny-by-default                           |
| A.9.2.1 User registration              | OIDC group-to-role mapping                               |
| A.9.4.2 Secure log-on                  | JWT signature verification, timing-safe key comparison   |
| A.12.4.1 Event logging                 | `AuditLogger` with chain hashes, WORM sink               |
| A.13.1.1 Network controls              | `SandboxConstraints.networkAllowed`, Docker network=none |
| A.14.1.2 Securing application services | Sandboxed execution, path traversal prevention           |

## Last Updated

- **Date**: 2026-05-27
- **Review cycle**: Quarterly
