# Security Policy

## Supported Versions

Security patches are applied to the latest stable release only.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue.**

Email: `security@kirkforge.dev`

- Expect an initial acknowledgment within **48 hours**.
- We'll keep you informed of progress every 5 business days.
- After triage, we aim to ship a fix within **7–14 days** depending on severity.
- If the issue is accepted, we'll publish a security advisory alongside the patch release.

## Threat Model (Summary)

KirkForge is a **deterministic verification and routing layer** for coding agents. Its security boundary assumes:

1. The host agent (Codex, Claude Code, OpenCode) is trusted to invoke KirkForge with valid input.
2. External tools (eslint, tsc, ruff, bandit) run in a sandboxed or trusted environment.
3. Secrets are managed externally via Vault → AWS → GCP → env chain (see `core-secrets`).
4. All file paths are sanitized via `safeRelativePath()` to prevent directory traversal.
5. Tenant isolation is enforced via `core-tenancy` for multi-tenant deployments.
6. **Docker sandbox is the default** for untrusted execution; bare-host runner requires explicit `ALLOW_UNSAFE_HOST_SANDBOX=1` opt-in.
7. Environment inheritance is deny-by-default; only `allowedEnvVars` are passed to child processes.
8. Path argument scanning is deny-by-default; empty `allowedReadPaths` means all path-like args are rejected.
9. Secret-pattern env vars are **rejected** (not just flagged) when detected by `scanEnvForSecrets`.

### Key Risks

- **Path traversal**: mitigated by `safeRelativePath()` in orchestrator and deny-by-default path scanning in sandbox.
- **Command injection**: external tools run via `execFile` (no shell interpolation). The one raw-shell path requires `ALLOW_UNSAFE_VALIDATOR_SHELL=1`.
- **Worker model hijack**: circuit breaker limits retries; model selection is host-controlled.
- **Secrets leakage**: `trufflehog` in CI + `.env.example` only (no real secrets committed). Deny-by-default env inheritance prevents host secrets from leaking to child processes.
- **Prototype pollution**: uses ES2022 + `structuredClone` internally; `Object.create(null)` where needed.
- **Sandbox escape on bare host**: mitigated by requiring explicit `ALLOW_UNSAFE_HOST_SANDBOX=1` opt-in. Docker isolation (`--network=none`, `--read-only`, `--memory`, `--pids-limit`) is the default for untrusted execution.
- **Inaccurate memory metrics**: resolved by reading `/proc/<pid>/status` on Linux; returns `null` on unsupported platforms rather than emitting misleading parent-process measurements.

### External Audit (Claude Opus 4.8, 2026-05-29)

All findings from external review have been resolved:

| Finding | Resolution |
|---------|-----------|
| Bare-host sandbox is default | `ALLOW_UNSAFE_HOST_SANDBOX=1` gate added; Docker is default |
| Env inheritance passes full parent env | Deny-by-default env; only `allowedEnvVars` passed |
| Path scanning disabled when `allowedReadPaths` empty | Empty list = deny all path-like args |
| `peakMemoryMb` reports parent not child | Reads `/proc/<pid>/status` on Linux; `null` on other platforms |
| `scanEnvForSecrets` flags but doesn't block | Secret-pattern env vars now rejected, not just flagged |
| `networkAllowlist` is advisory on bare host | Documented; Docker runner enforces `--network=none` |

## Audit & Compliance

- CI runs `npm audit` on every push (see `.github/workflows/ci.yml`).
- `trufflehog` secrets scanning is configured in CI.
- An SBOM (Software Bill of Materials) is generated per release.
- Dependabot monitors `npm` and GitHub Actions for known vulnerabilities.
