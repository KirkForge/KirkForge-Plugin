# Data classification & retention

This document is a starting point for enterprise/security review. It explains what data KirkForge _can_ store, why it exists, and how to minimize/retain/delete it.

> **Principle:** Minimize sensitive data. Prefer hashes/metadata over raw content. Make retention configurable. Provide deletion paths.

## Data categories

### 1) Routing memory

**What:** Observations about tasks (description snippets, language, mode/model, outcomes, durations).

**Risk:** Task descriptions may contain internal project names or incidental sensitive info.

**Controls:**

- Allow redaction of free-text fields.
- Allow disabling storage of descriptions entirely.
- Encrypt-at-rest option (where supported).

**Suggested retention:** 30–90 days by default.

### 2) Run logs

**What:** Structured logs emitted during verification/correction loops.

**Risk:** Logs may include file paths, tool errors, and potentially sensitive workspace names.

**Controls:**

- Strict redaction rules.
- Avoid logging file contents.
- Tenant/actor IDs should be logged, but secret values must never be.

**Suggested retention:** 7–30 days.

### 3) Artifacts metadata

**What:** Which files were written/modified, hashes, sizes, timestamps.

**Risk:** File names can leak internal structure.

**Controls:**

- Store hashes and counts; avoid content.
- Provide a configuration option to store only aggregates.

**Suggested retention:** 30–180 days depending on audit needs.

### 4) Audit events

**What:** Tamper-evident evidence of actions: actorId, tenantId, tool invoked, decision, timestamps, request IDs.

**Risk:** Audit logs grow quickly; must not contain secrets.

**Controls:**

- Append-only sink, rotation/retention.
- Strict schema and redaction.

**Suggested retention:** 90 days minimum; often 180–365 days.

## Deletion & data subject requests

Enterprise deployments should support:

- Delete by tenant
- Delete by run
- Global retention-based deletion

## Configuration knobs (recommended)

- `RETENTION_DAYS_*` per category (memory/logs/audit/artifacts)
- `STORE_TASK_DESCRIPTION=false` (store only hashed/taskId)
- `REDACT_PATTERNS` for log filtering
- `ENCRYPT_AT_REST=true` where supported

## Non-goals

KirkForge is not a records-management system. For long-term retention, export audit events to a SIEM or object storage with lifecycle policies.
