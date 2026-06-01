# KirkForge — Security & Deployment Checklist

> Honest status of every security and deployment feature. No padding, no spin.

## Reviewed by

Dark-Moon pentest (2026-05). AI-assisted security review.

## Feature status

| Feature | Status | Notes |
|---------|--------|-------|
| Deterministic verification loop | ✅ Working | 970 tests, emit→verify→correct→repeat |
| Correction prompt generation | ✅ Working | Compact error summaries, no model calls |
| Memory routing | ✅ Working | FileAdapter default, SqliteAdapter for durability |
| Task decomposition | ✅ Working | Topological sort, dependency ordering, retry |
| Native lint (8 languages) | ✅ Working | 103 rules across TS/Py/Shell/C/Rust/Go/SQL |
| Git diff tracking | ✅ Working | GitnexusEmitter |
| Import graph checking | ✅ Working | GraphifyEmitter |
| Sandbox (host runner) | ✅ Working | Deny-by-default commands, paths, env, output limits |
| Sandbox (Docker runner) | ✅ Working | `--network=none`, read-only fs, resource limits. Requires Docker + published image. |
| OIDC JWT/JWKS auth | ✅ Working | Verified in test |
| API key bearer auth | ✅ Working | Key ≥32 chars enforced |
| RBAC | ✅ Working | 4-role deny-by-default model |
| Policy engine | ✅ Working | Signed bundles (HMAC-SHA256 + Ed25519), tenant overrides |
| Multi-tenancy | ✅ Working | Tenant registry, path isolation, per-tenant keys |
| Audit trail (WORM) | ✅ Working | Chain-hash integrity, segment rotation, SIEM export |
| Enterprise startup gate | ✅ Working | Validates auth, audit, policy, storage before daemon start |
| Rate limiting / quotas | ✅ Working | Per-tenant, sliding window, file persistence |
| Health server | ⚠️ Minor bug | PUT/DELETE return 500 instead of 405. 3 test failures. |
| Docker image | 🟡 Not published | Dockerfile works locally, no published `kirkforge/sandbox` image |
| External pentest | 🟡 Not done | Dark-Moon review was AI-assisted, not a traditional pentest |
| Admin UI | 🟡 Not built | Deferred |
| Fleet management | 🟡 Not built | Deferred |

## Resolved findings from Dark-Moon review

| Finding | Resolution |
|---------|-----------|
| Bare-host sandbox was default | Docker is now default for untrusted code. Host runner requires `ALLOW_UNSAFE_HOST_SANDBOX=1`. |
| Env inheritance leaked full parent env | Deny-by-default: only `allowedEnvVars` passes through. |
| Empty `allowedReadPaths` was allow-all | Now deny-all. Empty list = no path args permitted. |
| `peakMemoryMb` reported parent process | Now reads `/proc/<pid>/status` on Linux. Returns null on unsupported platforms. |
| `scanEnvForSecrets` flagged but didn't block | Secret-typed env vars now rejected, not just flagged. |
| `networkAllowlist` advisory on bare-host | Documented. Docker runner enforces `--network=none` by default. |

## Known limitations

- FileAdapter is best-effort single-process. Use SqliteAdapter for multi-process durability.
- `/metrics` endpoint returns JSON, not Prometheus scrape format. Use OTel OTLP pipeline for Prometheus.
- `evictFromIndex()` removes from tenant index but not from disk (safety choice).
- Correction loop is bad at import-name errors (e.g., `PyPDF2` vs `pypdf`). No verifier catches that class. Escalation is the correct behavior.
- Cost thesis holds on short tasks. Untested on complex multi-file projects at scale.
