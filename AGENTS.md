# AGENTS.md — KirkForge Development Guide

**See also**: [REPORULES.md](../REPORULES.md) — multi-machine sync, git identity, SSH auth, and new-repo bootstrap.

## Rules

- **Never commit**: `node_modules/`, `dist/`, `.env`, `*.pem`, `*.key`, `*.log`, `.DS_Store`
- **Always pull before work, push after work**
- **Git identity**: `Henrik Kirk <285947470+KirkForge@users.noreply.github.com>`
- **Commit format**: `type(scope): message` — feat, fix, docs, refactor, test, chore, wip
- **Package manager**: npm. `npm ci` for installs, `npm run` for scripts.
- **Pre-push CI**: `ci-cleandev` hooks block pushes on failure. Fix, don't bypass.

## Project structure

KirkForge is a monorepo with 34 packages:

```
packages/
├── orchestrator/      — Core loop: delegate, verify, correct, escalate
├── correction-core/   — Build correction prompts from ReducedStatePacket
├── memory-palace/     — Task observation storage, routing bias recall
├── prompt-core/       — Task brief templates and emission schemas
├── agent-core/        — Model client wrapper
├── model-client/      — Provider routing (OpenAI, Anthropic, Ollama, etc.)
├── model-config/      — Model configuration and cost estimation
├── plugin/            — Public API surface (verifyWorkspace, doctor, etc.)
├── core-events/       — EventBus for verification emitters
├── core-types/        — Result<T,E>, shared type definitions
├── core-errors/       — Error catalog
├── core-logging/      — Structured logging with secret scrubbing
├── core-flags/        — Feature flags
├── core-config/       — Configuration loading and path validation
├── core-schemas/      — Zod validation schemas
├── core-sandbox/      — Host runner (deny-by-default) + Docker runner
├── core-rbac/         — Role/permission model (4 roles, deny-by-default)
├── core-policy/       — Policy engine, signed bundles
├── core-enterprise/   — Enterprise mode validation, quotas, rate limiting
├── core-tenancy/      — Tenant registry, path isolation
├── core-secrets/      — Chained providers: Vault → AWS → GCP → env
├── core-telemetry/    — OpenTelemetry traces and metrics
├── tool-gitnexus/     — Git diff emitter (internal, always available)
├── tool-graphify/     — Import graph emitter (internal, always available)
├── tool-lint-core/    — Shared lint engine
├── tool-lint-{ts,py,sh,c,rs,go,sql}/  — Language-specific lint rules
├── tool-tsc/          — TypeScript type-check emitter (external, probed)
└── tool-pyright/      — Python type-check emitter (external, probed)
apps/
└── cli/               — Standalone CLI
```

## Key concepts

- **Verifier pass ≠ task pass.** Verification checks code quality. Only the host decides task outcome.
- **No model calls in verification.** Lint, types, security, diff, graph — all deterministic.
- **Fail-closed.** Unknown states return errors, not guesses.
- **Brain/Brawn/Verifier.** Brain (expensive) delegates. Brawn (cheap) writes code. Verifier (free) checks. Brain sees only the reduced state, never raw Brawn output.

## Design decisions

See `docs/adr/`:
- ADR-001: Why Result<T,E> instead of exceptions
- ADR-002: Why no model calls in verification
- ADR-003: Why ESM over CJS
- ADR-004: Why separate tool packages per language
- ADR-005: Verification commoditizes model choice (the core thesis)

## Testing

```bash
npm test          # Batched test suites
npm run ci        # build + lint + test
npx vitest run    # Full vitest (970 tests, 66 suites)
```

Known: 3 health-server tests fail (PUT/DELETE return 500 instead of 405). Everything else passes.
