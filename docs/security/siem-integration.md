# SIEM Integration Guide

KirkForge supports structured audit event forwarding to SIEM platforms via the
`core-events` audit module. This guide covers configuration for common SIEM
platforms.

## Audit Event Schema

Every audit event includes:

| Field        | Type   | Description                                     |
| ------------ | ------ | ----------------------------------------------- |
| `id`         | string | Unique event ID                                 |
| `sequence`   | number | Monotonically increasing sequence number        |
| `timestamp`  | string | ISO 8601 timestamp                              |
| `action`     | string | Audit action type (see below)                   |
| `outcome`    | string | `success`, `deny`, `error`, or `skipped`        |
| `actorId`    | string | User or service account identifier              |
| `tenantId`   | string | Tenant scope                                    |
| `reason`     | string | Human-readable reason (especially for denies)   |
| `chainHash`  | string | SHA-256 hash chain for tamper evidence          |
| `policyHash` | string | Policy hash at time of decision (if applicable) |
| `traceId`    | string | OpenTelemetry trace correlation ID              |
| `metadata`   | object | Additional context                              |

### Audit Actions

```
auth.success, auth.failure, auth.token_refresh
policy.check, policy.deny, policy.change
tenant.create, tenant.evict, tenant.access
verify.start, verify.complete
correct.start, correct.complete
observe.record, observe.recall
memory.read, memory.write, memory.delete
secret.access, secret.resolve
config.change
tool.invoke, tool.deny
model.invoke, model.deny
system.startup, system.shutdown, system.error
```

## Syslog / CEF Integration

The `SyslogAuditSink` formats events in CEF (Common Event Format) for SIEM
ingestion. Configure it in your environment:

```bash
AUDIT_SINK_TYPE=syslog
AUDIT_SYSLOG_HOST=siem.example.com
AUDIT_SYSLOG_PORT=514
AUDIT_SYSLOG_TRANSPORT=udp  # or tcp
AUDIT_SYSLOG_FACILITY=1     # user-level
AUDIT_SYSLOG_APPNAME=kirkforge
```

### CEF Format

```
<priority><timestamp> <hostname> kirkforge audit: CEF:0|KirkForge|Audit|1.0|<action>|<reason>|<severity>|actor=<actorId> tenant=<tenantId> outcome=<outcome> chainHash=<chainHash>
```

Severity mapping:

- `deny`/`error` → **Medium** (severity 4)
- `success` → **Low** (severity 6)
- `skipped` → **Debug** (severity 7)

## File-Based Audit (WORM-Compatible)

For compliance environments requiring write-once storage:

```bash
AUDIT_SINK_TYPE=file
AUDIT_FILE_PATH=/var/log/kirkforge/audit.jsonl
```

File audit supports automatic rotation:

- `AUDIT_MAX_FILE_SIZE_BYTES` — rotate at this size (default: 50MB)
- `AUDIT_MAX_ROTATED_FILES` — keep this many rotated files (default: 10)

For WORM compliance, symlink the audit directory to a write-once mount point.

## HTTP/SIEM Forwarding

For platforms like Splunk HEC, Elastic, or Sentinel:

```bash
AUDIT_SINK_TYPE=http
AUDIT_HTTP_URL=https://splunk.example.com:8088/services/collector/event
AUDIT_HTTP_HEADERS=Authorization: Splunk <hec-token>
```

Each audit event is sent as a JSON POST with the full `AuditEvent` schema.

## Integration with Auth Audit Hook

Wire RBAC decisions to the audit logger in your application layer:

```typescript
import { createAuthAuditHook } from "@kirkforge/plugin";
import { AuditLogger, MemoryAuditSink } from "@kirkforge/core-events";
import { authorize, authorizeTenant } from "@kirkforge/core-rbac";

const audit = new AuditLogger(new MemoryAuditSink()); // or FileAuditSink, SyslogAuditSink
const hook = createAuthAuditHook(audit, "default-tenant-id");

// Every authorize call now emits an audit event
authorize(actor, "dev:verify", hook); // emits auth.success or auth.failure
authorizeTenant(actor, "dev:verify", "t1", hook); // includes targetTenantId
```

## Per-Tenant Quota Enforcement

Use the `QuotaManager` from `@kirkforge/core-enterprise` to enforce per-tenant limits:

```typescript
import { QuotaManager } from "@kirkforge/core-enterprise";

const quotas = new QuotaManager({
  maxConcurrentTasks: 4,
  maxVerifyRunsPerHour: 500,
  maxDailyTokens: 1000000,
});

// Set tenant-specific quotas
quotas.setQuota("tenant-alpha", { maxConcurrentTasks: 16, maxDailyTokens: 5000000 });

// Check before action
const check = quotas.checkQuota("tenant-alpha", "verify_run");
if (!check.ok) {
  // Return quota exceeded error
}

// Record usage
quotas.recordUsage("tenant-alpha", { hourlyVerifyRuns: 1 });
```

## Signed Policy Bundles

Enterprise deployments can distribute policy files with integrity guarantees:

```typescript
import { PolicyEngine, signPolicyHmac, verifySignedPolicy } from "@kirkforge/core-policy";

// Signing (admin side)
const engine = new PolicyEngine(myPolicy);
const bundle = signPolicyHmac(engine.getPolicy(), engine.getHash(), secretKey, "key-2024");

// Verification (service side)
const result = verifySignedPolicy(bundle, secretKey);
if (result.ok) {
  // Policy is verified — load it
  engine.loadFromVerified(result.value);
}
```

HMAC-SHA256 is supported now. Ed25519 is planned for production hardening.
