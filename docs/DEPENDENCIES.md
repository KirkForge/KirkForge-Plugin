# KirkForge Plugin — Dependency Rationale

**Updated:** 2026-06-07

This document explains the dependency choices that look unusual for a
verifier-class product. The goal is to make it obvious which choices are
deliberate, which are pinned for stability, and which we will revisit.

## Bleeding-edge versions currently used

| Package | Current range | Why it's pinned here | Stability risk |
| ------- | ------------- | -------------------- | -------------- |
| `typescript`          | `^6.0.3`  | Tracks the version that introduced stricter null-narrowing for the `tsc` wrapper test fixtures. Pin will move to `^5.6` once the codebase no longer relies on TS 6 type narrowing. | Medium — TS 6 is pre-stable in some toolchains. |
| `eslint`              | `^10.4.0` | New flat-config-only major; pre-10 had a compat shim. Pin stays on 10.x. | Low — flat config is the official path forward. |
| `vitest`              | `^4.1.8`  | Vitest 4 changes worker-pool defaults. Our test suite uses `pool: "forks"` and `maxConcurrency: 4`; both are validated. Pin stays on 4.x. | Low. |
| `@typescript-eslint/parser` | `^8.60.1` | Pinned to match the version `typescript-eslint` requires for TS 6. | Low. |
| `@types/node`         | `^25.9.1` | Node 25 is in active LTS. We declare `engines.node: ">=20"`, so the types should not break older runtimes — they're a dev-only dep. | Low. |

## Why we don't pin everything to N-1

For a verifier product, "boring deps" is the right default. The
devDependency tree above is dev-only (lint, format, typecheck) and does
not run in production. The runtime dep tree is small:

| Runtime dep        | Why it's here                                    | Why not a smaller alternative         |
| ------------------ | ------------------------------------------------ | -------------------------------------- |
| `commander`        | CLI command parsing                              | Standard for Node CLIs; tiny.         |
| `zod`              | Runtime input validation (decomposition, schemas) | Hand-rolled validators regress silently. |
| `@opentelemetry/*` | Optional metrics + trace export                  | Required for the `serve` command.      |

## When we will downgrade

- `typescript ^6.0.3` → `^5.6` once the engine tests no longer depend on
  TS 6 type-narrowing behavior. Tracked under the in-flight typecheck
  follow-up; not a blocker for the verifier contracts.
- `eslint ^10.4.0` → `^9.x` if we hit incompatibilities with a plugin
  that has not yet shipped a 10.x-compatible release. None observed at
  the time of this writing.

## Production-only safeguards

The following runtime environment variables gate unsafe behavior. They
are the safety rails that compensate for "bleeding-edge" in the
dependency tree:

- `ALLOW_UNSAFE_HOST_SANDBOX=1` — opt in to the bare-host sandbox runner
  for untrusted or model-influenced code. Default: off. Enterprise mode
  forces the Docker path regardless.
- `ALLOW_UNSAFE_VALIDATOR_SHELL=1` — opt in to raw shell task
  validators. Default: off. The orchestrator's `_runTaskValidator`
  returns `status: "error"` without this flag.
- `KIRKFORCE_ENTERPRISE_MODE=true` (or `DOPAFLOW_ENTERPRISE_MODE` —
  cross-compatible) — forces container isolation, gates the bare-host
  runner, enables signed-policy enforcement.
