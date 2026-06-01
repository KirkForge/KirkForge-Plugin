# KirkForge

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/kirkforge-banner.svg">
  <img src="docs/assets/kirkforge-banner.png" alt="KirkForge — Deterministic verification for coding agents" width="100%">
</picture>

[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-support%20my%20hardware-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/KirkForge)

**Deterministic verification plugin for coding agents.** KirkForge is not a standalone agent. It plugs into Codex, Claude Code, OpenCode, or any agent stack as a verification, correction, and routing layer.

## How it works

The core insight: **verification commoditizes model choice.**

| Role         | Cost      | Job                                                    |
| ------------ | --------- | ------------------------------------------------------ |
| **Brain**    | Expensive | Plans, delegates, decides next action. The host agent. |
| **Brawn**    | Cheap     | Generates code from a prompt. A worker model.         |
| **Verifier** | Free      | Lint, types, security, diff, imports. KirkForge. No model calls. |

The Brain sends a task to the Brawn in JSON. The Brawn writes code. KirkForge's deterministic tools run on the output. If the Brawn messes up, KirkForge builds a compact correction prompt — not a summary, the actual errors — and the Brain decides whether to retry, switch models, or escalate. The Verifier never calls a model. The Brain never sees raw Brawn output, only the reduced state.

This is the loop: **emit → verify → correct → repeat.**

When correction fails, the Brain takes over — the Ferrari leaves the garage. But most tasks don't need the Ferrari. On measured tasks, mid-tier models + verification match frontier models at 2–4× lower token cost.

See [ADR-005: Verification commoditizes model choice](docs/adr/005-cheap-worker-thesis.md) for the data.

## What it does

1. **Verify** — Run lint, type-check, security, git-diff, and import-graph checks on a workspace. Deterministic, no model calls.
2. **Prompt** — Build a compact correction prompt from verification failures. Ready for the next model turn.
3. **Observe** — Record task outcomes (pass/fail/escalate) so future tasks can benefit from empirical routing.
4. **Recall** — Retrieve routing bias from past observations to recommend model and mode.
5. **Decompose** — Break complex tasks into smaller, independently verifiable subtasks.

The core invariant: **verifier pass ≠ task pass.** Verification checks code quality. Only the host knows whether the task succeeded. Memory stores host-reported outcomes, never verifier status.

## Quick start

```bash
npm ci && npm run build && npm test

# Probe available tools
npx tsx apps/cli/src/index.ts doctor --pretty

# Verify a workspace (no model call)
npx tsx apps/cli/src/index.ts verify-workspace --workspace /path/to/project

# Build correction prompt from verification result
npx tsx apps/cli/src/index.ts prompt --packet result.json

# Record a task observation
npx tsx apps/cli/src/index.ts observe --memory mem.json \
  --task-id t1 --description "fix auth" --language typescript \
  --mode hard-prompt --model gpt-4 --outcome pass --duration-ms 5000

# Recall routing bias
npx tsx apps/cli/src/index.ts recall --memory mem.json --description "fix auth"

# Start daemon
npx tsx apps/cli/src/index.ts serve
# curl http://localhost:9090/healthz
```

## CLI commands

| Command              | What it does                                                    |
| -------------------- | --------------------------------------------------------------- |
| `delegate`           | Task delegation with automatic mode routing                    |
| `run`                | Execute task with correction loop (accept/correct/escalate)     |
| `verify-workspace`   | Deterministic verification → `ReducedStatePacket`              |
| `decompose`          | Break complex task into dependency-ordered subtrees             |
| `recall-decomposition` | Inspect stored decompositions                                 |
| `observe`            | Record task outcome for routing memory                          |
| `recall`             | Retrieve routing bias for similar tasks                        |
| `health`             | Orchestrator health and SLO status                              |
| `serve`              | Daemon mode with health-check server (port 9090)               |
| `doctor`             | Internal + external tool availability diagnostic                |
| `tools`              | List registered verification tools                              |

## Delegation modes

| Mode              | How it works                                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `hard-prompt`     | Brain sends freeform instructions, Brawn writes code blocks, Verifier checks |
| `schema-contract` | Brain sends a JSON schema, Brawn fills it, Verifier validates structure  |
| `artifact`         | Brawn emits JSONL file-write artifacts, Verifier checks path safety      |

## Verifier tools

| Tool        | What it checks                     | Source    |
| ----------- | ---------------------------------- | --------- |
| lint        | 8 languages, 103 rules total       | internal  |
| types       | tsc (TS), pyright (Python)         | external  |
| security    | Safety-category lint rules         | internal  |
| changes     | git diff (via GitnexusEmitter)     | internal  |
| graph       | Import graph broken-edge detection | internal  |

Internal tools are bundled and always available. External tools (tsc, pyright) are probed from PATH.

## Design invariants

- **No model calls** in any verification or correction path. All five commands are deterministic.
- **stdout is data, stderr is diagnostics.** Hosts parse stdout; stderr is for humans.
- **Verifier fail is not exit 1.** The `ReducedStatePacket` is the product regardless of verdict.
- **Memory is explicit.** `observe` and `recall` require `--memory <path>`. No ambient state.
- **Host decides task outcome.** `observe --outcome` must come from the host's validator, never from verification status. Verifier pass ≠ task pass.


## MCP Server

KirkForge ships a Model Context Protocol server for direct integration with MCP hosts (Claude Desktop, Codex CLI, Copilot, etc.):

```json
{
  "mcpServers": {
    "kirkforge": {
      "command": "npx",
      "args": ["@kirkforge/mcp"]
    }
  }
}
```

Or run directly:

```bash
npx tsx apps/mcp/src/index.ts
```

See [apps/mcp/README.md](apps/mcp/README.md) for the full tool list and configuration.

## Project stats

- 34 packages (29 library + 5 lint engine + CLI)
- 970 tests across 66 suites
- ~22,500 lines production code, ~15,300 lines test code
- Node.js ≥ 20, Git required for diff tracking

## Architecture decisions

- [ADR-001: Deterministic verification outside the model](docs/adr/001-deterministic-verification.md)
- [ADR-002: Event-driven reduction for state convergence](docs/adr/002-event-driven-reducer.md)
- [ADR-003: Language-aware emission contracts](docs/adr/003-language-aware-contracts.md)
- [ADR-004: Memory as weighted pass-rate routing](docs/adr/004-memory-routing-engine.md)
- [ADR-005: Verification commoditizes model choice](docs/adr/005-cheap-worker-thesis.md)

## Deployment

| Method         | Command                                                        |
| -------------- | -------------------------------------------------------------- |
| Docker         | `docker build -t kirkforge . && docker run -p 9090:9090 kirkforge` |
| Docker Compose | `docker-compose up -d`                                         |
| GHCR           | `docker pull ghcr.io/kirkforge/kirkforge:latest`               |
| Kubernetes     | `helm install kirkforge ./deploy/helm/kirkforge`               |

## Security and multi-tenancy

KirkForge ships with security features for team and production use:

- **Sandbox**: Docker runner for untrusted code (default), host runner with deny-by-default constraints
- **Auth**: OIDC JWT/JWKS verification, API key bearer tokens
- **RBAC**: Four-role deny-by-default model (admin, operator, developer, viewer)
- **Policy engine**: Deny-by-default allowlists for commands, paths, and networks. Signed bundles (HMAC-SHA256 + Ed25519).
- **Multi-tenancy**: Tenant registry with path isolation, per-tenant encryption keys, cross-tenant access control
- **Audit**: Append-only WORM log with chain-hash integrity and SIEM export
- **Enterprise mode**: Startup gate validates auth, audit, policy, and storage before daemon starts

These are guardrails, not the product. The product is deterministic verification that makes cheap models productive.

## Requirements

- Node.js ≥ 20
- Git (for gitnexus diff tracking)
- Optional: ESLint, TypeScript, ruff, pyright, bandit (for language-specific verification)
- Optional: Docker (for sandboxed code execution)

## Clean repo validation

```bash
bash scripts/ci.sh
# or: npm run ci
```

Runs `build`, `lint`, and `test` in sequence. Exits on first failure.
