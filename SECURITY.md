# Security Policy

## Supported Versions

Security patches are applied to the latest stable release only.

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Do not open a public issue.**

Email: `security@55ndeep.dev`

- Expect an initial acknowledgment within **48 hours**.
- We'll keep you informed of progress every 5 business days.
- After triage, we aim to ship a fix within **7–14 days** depending on severity.
- If the issue is accepted, we'll publish a security advisory alongside the patch release.

## Threat Model (Summary)

55NDeep is a **deterministic verification and routing layer** for coding agents. Its security boundary assumes:

1. The host agent (Codex, Claude Code, OpenCode) is trusted to invoke 55NDeep with valid input.
2. External tools (eslint, tsc, ruff, bandit) run in a sandboxed or trusted environment.
3. Secrets are managed externally via Vault → AWS → GCP → env chain (see `core-secrets`).
4. All file paths are sanitized via `safeRelativePath()` to prevent directory traversal.
5. Tenant isolation is enforced via `core-tenancy` for multi-tenant deployments.

### Key Risks

- **Path traversal**: mitigated by `safeRelativePath()` in orchestrator.
- **Command injection**: external tools run via `execFile` (no shell interpolation).
- **Worker model hijack**: circuit breaker limits retries; model selection is host-controlled.
- **Secrets leakage**: `trufflehog` in CI + `.env.example` only (no real secrets committed).
- **Prototype pollution**: uses ES2022 + `structuredClone` internally; `Object.create(null)` where needed.

## Audit & Compliance

- CI runs `npm audit` on every push (see `.github/workflows/ci.yml`).
- `trufflehog` secrets scanning is configured in CI.
- An SBOM (Software Bill of Materials) is generated per release.
- Dependabot monitors `npm` and GitHub Actions for known vulnerabilities.
