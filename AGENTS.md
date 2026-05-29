
**See also**: [REPORULES.md](../REPORULES.md) — multi-machine sync, git identity, PAT handling, and new-repo bootstrap.

# ⚠️ Mandatory Rules — Read Before Editing

- **Never commit**: `node_modules/`, `.venv/`, `__pycache__/`, `*.pyc`, `dist/`, `.next/`, `coverage/`, `.mypy_cache/`, `.pytest_cache/`, `.DS_Store`, `*.log`, `.env`, `*.pem`, `*.key`
- **Always pull before work, push after work**
- **Git identity**: `Henrik Kirk <285947470+KirkForge@users.noreply.github.com>`
- **Commit format**: `type(scope): message` — feat, fix, docs, refactor, test, chore, wip
- **Package manager**: This project uses **npm**. Always use `npm ci` for installs, `npm run` for scripts.
- **Pre-push CI**: `ci-cleandev` hooks block pushes on failure. Fix, don't bypass.

---

# AGENTS.md — 55NDeep Integration Guide

## Purpose

55NDeep is a **deterministic verification and routing layer** for coding agents. It plugs into Codex CLI, Claude Code, OpenCode, LangChain, and any agent stack that can invoke external tools.

## Integration Patterns

### Codex CLI Plugin

55NDeep ships with a `.codex-plugin/plugin.json` manifest. Install via:

```
codex plugin install 55ndeep
```

Then configure in your Codex session:

```jsonc
{
  "plugins": {
    "55ndeep": {
      "policy": "strict", // "strict" | "lenient"
      "languages": ["typescript", "python"],
      "maxConcurrent": 4,
    },
  },
}
```

### Shell Adapter (any host)

The `examples/shell-adapter/` directory contains a bash adapter that wraps 55NDeep for any agent capable of running shell commands:

```bash
./55ndeep verify --workspace /path/to/project --language typescript
./55ndeep correct --packet result.json --language typescript
./55ndeep doctor
```

### Programmatic (npm)

```ts
import { createPluginCore } from "@55ndeep/plugin";

const plugin = createPluginCore({ memoryStore: myStore });

// Pre-task verification
const verifyResult = await plugin.verifyWorkspace({
  workspace: "/path/to/project",
  language: "python",
  files: ["src/main.py"],
});

// Post-task observation recording
await plugin.recordObservation({
  taskId: "task-123",
  description: "Add login endpoint",
  language: "python",
  mode: "implement",
  model: "claude-sonnet-4-20250514",
  outcome: "pass",
  durationMs: 45000,
});

// Routing bias recall
const bias = await plugin.recallRoutingBias("Add login endpoint", "claude-sonnet-4-20250514");
```

## Key Files

- `packages/plugin/src/index.ts` — Public API (`verifyWorkspace`, `doctor`, `buildCorrectionPrompt`, `recordObservation`, `recallRoutingBias`)
- `packages/orchestrator/` — Verification pipeline: lint, types, security, changes, graph
- `packages/correction-core/` — Correction prompt generation from verification packets
- `packages/memory-palace/` — Task observation storage and routing bias recall
- `packages/core-tenancy/` — Multi-tenant isolation
- `packages/core-secrets/` — Chained secrets: Vault → AWS → GCP → env
- `apps/cli/` — Standalone CLI (`npx tsx apps/cli/src/index.ts serve`)

## Design Principles

1. **Deterministic verification** — No model calls in verification/correction paths. Pure tooling.
2. **Fail-closed** — Unknown states return errors, not guesses.
3. **Path safety** — All file paths go through `safeRelativePath()` before use.
4. **Circuit breaker** — Worker model failures trigger cooldown, then escalate.
5. **Tenant isolation** — Storage, events, and config are tenant-scoped.

## Architecture Decision Records

See `docs/adr/` for architectural decisions:

- ADR-001: Why Result<T,E> instead of exceptions
- ADR-002: Why no model calls in verification
- ADR-003: Why ESM over CJS
- ADR-004: Why separate tool packages per language
- ADR-005: Why circuit breaker in orchestrator

---

## 🔒 Secure-Defaults Checklist (Definition of Done)

> **The rule:** The secure state is the DEFAULT. Opening it up is an EXPLICIT, LOGGED, opt-in — never the fallback.

### Network binding
- [ ] Servers bind `127.0.0.1` by default. Non-loopback requires explicit flag/env AND auth enabled.
- [ ] Non-loopback bind logs a startup WARNING naming the exposure.
- [ ] CORS / allowed-hosts default to an explicit allowlist, never `["*"]`.

### Secrets
- [ ] No secret has a usable default value. Missing secret in production → refuse to boot (`exit 1`).
- [ ] Empty-string / placeholder secrets are never a valid signing key, even in dev. Generate random per-process secret if none supplied (+ warning).
- [ ] No secret value is written into generated artifacts (systemd units, configmaps, scripts).
- [ ] Secrets come from env or a secret manager — never a committed file. `*token*.json`, `credentials*.json` etc. are gitignored.

### Comparisons (constant-time)
- [ ] Every secret / token / signature / hash comparison uses constant-time compare (`hmac.compare_digest` / `crypto.timingSafeEqual`), never `==` / `!==`.
- [ ] `grep -rEn '(sig|hmac|token|secret|hash|key)\b.*(==|!=|!==)' src/` returns nothing that compares a secret.

### Allowlists / deny-by-default
- [ ] An empty allowlist means DENY, never ALLOW-ALL.
- [ ] Filesystem paths from tool/API input are confined to a configured root by default; arbitrary paths require explicit opt-in.
- [ ] Command execution uses argv arrays, never `shell=True` / string interpolation. Raw-shell paths gated behind `ALLOW_UNSAFE_*=1`, default off.

### Multi-tenant isolation
- [ ] Every shared store (sessions, cache, files, memory, routing) is keyed by `tenant_id`, not a global namespace.
- [ ] List/enumerate endpoints scope results to the calling tenant.
- [ ] Identity (owner/role/tenant) is derived from the authenticated session/token, never from the request body.
- [ ] At least one test asserts tenant A cannot read/modify tenant B's data.

### Authorization (not just authentication)
- [ ] Every protected endpoint calls BOTH authn (who are you) AND authz (are you allowed).
- [ ] New endpoints are deny-by-default — added to the authz table, not left to fall through.

### Sandbox / untrusted execution
- [ ] Child processes get an explicit env allowlist, not `{...process.env}` inheritance.
- [ ] For untrusted/model-generated code, real isolation (container/microVM/namespaces + rlimits + no-new-privs) is the DEFAULT path; bare-host "constrained" is opt-in with a warning.
- [ ] Isolation claims in README match what the code enforces. No "kernel-enforced"/"enterprise-grade" unless it is.

### Claims vs reality
- [ ] README maturity label matches code reality.
- [ ] Threat model is documented for anything that takes untrusted input.
- [ ] No dead code that implies a capability the product doesn't have.
