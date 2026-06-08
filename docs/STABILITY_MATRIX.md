# KirkForge Plugin — Component Stability Matrix

**Updated:** 2026-06-07

This matrix rates each KirkForge package and CLI surface by stability and
what users can rely on. Stability here means:

- **Stable** — works, has tests, and the public surface is not expected to
  change in backward-incompatible ways without a migration.
- **Beta** — works for the common case, but the data model or API may
  shift. Suitable for daily use; do not depend on the schema being stable.
- **Experimental** — works in a narrow path only, or is a stub. Expect
  data loss, layout shifts, or rewrite.
- **Dev-only** — exists for development and is unreachable or disabled
  in production builds.

## Core packages (foundation layer)

| Package             | Stability    | Notes                                                       |
| ------------------- | ------------ | ----------------------------------------------------------- |
| `core-types`        | Stable       | `Result<T,E>`, `ok/err` helpers, event types.              |
| `core-errors`       | Stable       | Typed error hierarchy.                                      |
| `core-events`       | Stable       | EventBus with idempotency, buffer, drain; audit sinks.      |
| `core-config`       | Stable       | Config loader; environment-driven.                          |
| `core-logging`      | Stable       | Structured logger with secret scrubbing.                    |
| `core-tenancy`      | Stable       | Tenant registry, isolation, tenant-scoped encryption.       |
| `core-secrets`      | Stable       | SigV4 signing, redaction, tenant-key derivation.           |
| `core-rbac`         | Stable       | Actor model, role checks, JWT verify.                       |
| `core-policy`       | Beta         | Policy engine + signed policies; rules evolve.              |
| `core-enterprise`   | Beta         | QuotaManager, EnterpriseMode flags. Tenancy integration in flux. |
| `core-sandbox`      | Beta         | Constraint enforcement + Docker runner. Bare-host runner gated by `ALLOW_UNSAFE_HOST_SANDBOX=1`; full process-level isolation requires Docker. |
| `core-schemas`      | Stable       | Zod schemas for ReducedStatePacket and event payloads.      |
| `core-telemetry`    | Beta         | OTel wiring; metrics export.                                |
| `core-flags`        | Beta         | Feature flag evaluation.                                    |

## Memory and model

| Package             | Stability    | Notes                                                       |
| ------------------- | ------------ | ----------------------------------------------------------- |
| `memory-palace`     | Beta         | InMemory + SQLite + File adapters; `writeTaskObservation`, `writeRunAndEmissions` API. SQLite adapter depends on `better-sqlite3` and falls back to FileAdapter when unavailable. |
| `model-config`      | Stable       | Provider config loader (YAML/JSON).                         |
| `model-client`      | Beta         | HTTP client to providers; retries. Per-provider auth flows. |
| `plugin`            | Stable (verify/correct/memory/doctor) / Beta (auth/tenant) | Public API surface for host agents. Verification & correction exports are stable; the auth/tenant/audit-bridge exports are stable in shape but the role model may evolve. The CLI/MCP `serve` endpoint is Beta (see `kirkforge serve` row). |

## Correction and agent

| Package             | Stability    | Notes                                                       |
| ------------------- | ------------ | ----------------------------------------------------------- |
| `agent-core`        | Beta         | Agent loop; prompt execution; tool wrapping.                |
| `prompt-core`       | Beta         | Built-in templates (hard-prompt, schema-contract, artifact, task-decompose). Response schemas may evolve. |
| `correction-core`   | Beta         | decideCorrection, buildCorrectionPrompt, task-validator. Decision boundaries (when to correct vs. escalate) are part of the public surface. |
| `orchestrator`      | Beta         | Full delegation + correction loop. The reducer (`StateReducer.reduce`) is the public reducer contract. The `_runIsolatedTurn` workspace-copy is internal. |

## Tool wrappers (verifiers)

| Package             | Stability    | Notes                                                       |
| ------------------- | ------------ | ----------------------------------------------------------- |
| `tool-tsc`          | Stable       | FAIL-CLOSED on missing tsc binary. Returns `Result.err` + status:"error". |
| `tool-pyright`      | Stable       | FAIL-CLOSED on missing pyright. Returns `Result.err` + status:"error". |
| `tool-graphify`     | Stable       | Static import-edge analysis. "No JS/TS files" = `status:"skipped"` (legitimate). Internal errors return `status:"error"`. |
| `tool-gitnexus`     | Beta         | Change tracking via git + writtenFiles overlay. Edge cases around untracked files and empty repos. |
| `tool-lint-core`    | Stable       | Pure regex engine. In-process — no binary dependency.       |
| `tool-lint-ts`      | Stable       | TS-flavored rules on top of `tool-lint-core`.               |
| `tool-lint-py`      | Stable       | Python-flavored rules.                                      |
| `tool-lint-sh`      | Stable       | Shell rules (curl-bash-pipe, rm-rf-*, eval).                |
| `tool-lint-c`       | Stable       | C / C++ rules.                                              |
| `tool-lint-rs`      | Stable       | Rust rules.                                                 |
| `tool-lint-go`      | Stable       | Go rules.                                                   |
| `tool-lint-sql`     | Stable       | SQL safety + correctness rules.                             |
| `tool-lint-imports` | Stable       | Curated import-rename tables for Python (PyPDF2→pypdf, distutils, urllib2, …) and TypeScript (request, moment, mkdirp, …). Advisory by default — emits `verify.imports` as a warn-level slot, never fail-closed. |

## CLI surfaces

| Command             | Stability    | Notes                                                       |
| ------------------- | ------------ | ----------------------------------------------------------- |
| `kirkforge verify`  | Stable       | Run verification emitters on cwd. JSON output available.    |
| `kirkforge delegate`| Beta         | End-to-end delegation with mode routing.                    |
| `kirkforge doctor`  | Stable       | Environment / config / model health.                        |
| `kirkforge observe` | Beta         | Memory store inspection.                                    |
| `kirkforge audit-verify` | Beta    | Audit log verification.                                     |
| `kirkforge serve`   | Beta         | Daemon mode. `/healthz`, `/readyz`, `/v1/metrics` (Prometheus text), RBAC, and graceful shutdown are stable. Use `--config` for repeatable deployments. Production hardening (TLS termination, mTLS, process supervision) is the operator's responsibility. |

## What this means for users

- **Use freely:** `core-*` packages, `tool-lint-*`, `tool-tsc`, `tool-pyright`,
  `tool-graphify`, the `verify` and `doctor` CLI commands.
- **Use with care (API may change):** `core-policy`, `core-enterprise`,
  `core-sandbox`, `memory-palace`, `model-client`, `agent-core`, `prompt-core`,
  `correction-core`, `orchestrator`.
- **Don't depend on:** pre-1.0 memory layout for cross-version
  compatibility.
- **Sandbox guarantees are narrow:** the bare-host runner provides constraint
  enforcement (allowlists, timeouts, output limits) but NOT process-level
  isolation. For untrusted or model-influenced code, use
  `runDockerSandboxed()` (or set `ALLOW_UNSAFE_HOST_SANDBOX=1` to opt in to
  the bare-host runner for trusted tools). Enterprise mode forces the Docker
  path.

## Verifier fail-closed contract

All tool wrappers that shell out to an external binary (currently
`tool-tsc` and `tool-pyright`) MUST follow this contract:

1. **No target files** (e.g. no `tsconfig.json` for tsc, no `*.py` for
   pyright): `status: "skipped"`, `Result.ok({ errors: 0, ... })`. This is
   a legitimate skip because there is nothing to verify.
2. **Target files exist, binary missing (ENOENT)**: `status: "error"`,
   `Result.err(...)`, `errors: 1`, with a `VERIFIER_MISSING_BINARY` detail.
   The reducer (`StateReducer.reduce`) treats `status: "error"` as a
   verifier failure and sets `overall: "fail"`. This is the fail-closed
   invariant — a missing binary must NOT look like a pass.
3. **Target files exist, binary present**: `status: "pass" | "fail"`
   based on the binary's actual output, `Result.ok(...)` with the
   appropriate errors count.

The reducer's behavior:
- `status: "skipped"` for a slot in `policy.required` → `skippedRequired.push(slot)` → `overall: "fail"`.
- `status: "skipped"` for a slot NOT in `policy.required` → no effect on overall.
- `status: "error"` for any slot → `verifierError` is true → `overall: "fail"`.
- `status: "fail"` with `errors > 0` → `overall: "fail"`.

This contract is enforced by `packages/orchestrator/tests/verifier-fail-closed.test.ts`
(6 integration tests across skip/error/pass/fail combinations).
