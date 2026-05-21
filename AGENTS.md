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
      "policy": "strict",   // "strict" | "lenient"
      "languages": ["typescript", "python"],
      "maxConcurrent": 4
    }
  }
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
