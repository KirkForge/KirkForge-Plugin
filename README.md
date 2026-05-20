# 55NDeep

**Deterministic delegation plugin for coding agents.** 55NDeep is not a standalone agent framework. It plugs into Codex, Claude Code, OpenCode, LangChain-style orchestrators, and internal agent stacks as a verification, correction, and routing layer.

## Framing: Brain, Brawn, Verifier

| Role | Cost | What it does |
|------|------|-------------|
| **Brain** | Expensive | Orchestrates: plans, delegates, decides next action. The host CLI or orchestrator. |
| **Brawn** | Cheap | Generates: writes code from prompts. A worker model. |
| **Verifier** | Free | Inspects state: lint, types, security, diffs, imports. 55NDeep. Deterministic. No model calls. |

55NDeep sits between Brawn and Brain. After a worker emits code, 55NDeep verifies the output with deterministic tools. If verification fails, it builds a compact correction prompt. The Brain decides whether to retry, switch models, or escalate. This is the core loop: **emit → verify → correct → repeat.**

The claim is **cost-reduced delegation through deterministic emissions**, not that small models beat frontier models. Deterministic verification makes any model's output more reliable, and empirical routing memory makes future delegation more efficient.

## What it does

1. **Verify** — Run lint, type-check, security, git-diff, and import-graph checks on a workspace. No model calls. Deterministic.
2. **Prompt** — Build a compact correction prompt from verification failures. Ready to inject into the host CLI's next model turn.
3. **Observe** — Record task outcomes (pass/fail/escalate) so that future tasks can benefit from empirical routing.
4. **Recall** — Retrieve routing bias from past observations to recommend mode and model for similar tasks.
5. **Decompose** — Break complex tasks into smaller, independently verifiable subtasks with dependency ordering. Optionally execute them in sequence with `--execute`.

The core invariant: **verifier pass ≠ task pass.** Verification checks code quality; only the host knows whether the task actually succeeded. Memory stores host-reported task outcomes, never verifier status.

## What it integrates with

55NDeep is designed as a plugin layer for existing systems:

- **Codex** — shell command adapter
- **Claude Code** — shell command adapter
- **OpenCode** — Node library adapter or native plugin
- **LangChain-style orchestrators** — Node library adapter
- **Internal agent stacks** — shell or Node adapter

The `55ndeep` CLI binary is a **shell adapter and reference runner**, not the product. The product is the deterministic verification, correction, and routing logic that any host can call.

## What it competes against

- Expensive orchestration waste — burning frontier-model tokens on tasks a verifier can reject deterministically
- Vague model self-assessment — asking "does this look right?" instead of running lint + types
- Multi-agent and RAG systems that burn tokens to inspect prose that a deterministic check can validate in milliseconds

## Integration

### Shell command adapter (any host)

```sh
# 1. Verify workspace
55ndeep verify-workspace --workspace /path/to/project

# 2. Build correction prompt if needed
55ndeep prompt --packet result.json

# 3. Record task outcome (host-provided, not verifier-derived)
55ndeep observe --memory mem.json --task-id t1 --description "fix auth" \
  --language typescript --mode hard-prompt --model gpt-4 \
  --outcome pass --duration-ms 5000

# 4. Recall routing bias for future tasks
55ndeep recall --memory mem.json --description "fix auth"

# 5. Probe available verification tools
55ndeep doctor
55ndeep doctor --pretty

# 6. Decompose a complex task into subtasks
55ndeep decompose "Build a REST API with auth and rate limiting"

# 7. Decompose and execute in one step
55ndeep decompose "Build a REST API with auth and rate limiting" --execute

# 8. Recall a stored decomposition
55ndeep recall-decomposition "Build a REST API"
```

See [PLUGIN_CLI_CONTRACT.md](docs/PLUGIN_CLI_CONTRACT.md) for the full command reference, and [examples/shell-adapter/](examples/shell-adapter/) for a runnable integration script.

### Node library adapter

```ts
import {
  verifyWorkspace,
  buildCorrectionPrompt,
  recordObservation,
  recallRoutingBias,
  decomposeTask,
  executeDecomposition,
  doctor,
} from "@55ndeep/plugin";

const packet = await verifyWorkspace({ workspace: "/path/to/project" });
if (packet.ok && packet.value.verification.overall !== "pass") {
  const prompt = buildCorrectionPrompt(packet.value, { language: "typescript" });
  // feed `prompt` back into host model loop
}
```

## Verifier battery

| Domain | JS/TS | Python | Source | What it catches |
|---|---|---|---|---|
| Lint | ESLint | Ruff | external | Syntax, unused vars, structural issues |
| Types | tsc --noEmit | Pyright | external | Type errors |
| Security | Secdev | Bandit | external / external | Secrets, eval(), shell injection, API keys |
| Changes | GitNexus | GitNexus | internal | File diff stats, files written |
| Graph | Graphify | skipped | internal | Broken imports, cycles |

All verifiers run locally. No LLM in the verification path. Fail-closed: missing signals default to failure, never pass.

## Language support matrix

| Language | Emission schema | Required verifiers | Advisory verifiers | External tools | Internal tools | v1 status |
|----------|----------------|--------------------|--------------------|----------------|----------------|-----------|
| TypeScript | yes | lint, types, security | graph | eslint, tsc | secdev, gitnexus, graphify | First-class |
| JavaScript | yes | lint, security | types, graph | eslint | secdev, gitnexus, graphify | First-class |
| Python | yes | lint, types | security, graph | ruff, pyright, bandit | gitnexus, graphify advisory | First-class |
| Shell | yes | security | lint, types, graph | none required | secdev, gitnexus | Partial |
| C/C++ | yes | none required | lint, types, security, graph | none wired | gitnexus, secdev advisory | Experimental |
| Rust | yes | none required | lint, types, security, graph | none wired | gitnexus, secdev advisory | Experimental |
| Go | yes | none required | lint, types, security, graph | none wired | gitnexus, secdev advisory | Experimental |
| SQL | yes | none required | lint, types, security, graph | none wired | gitnexus, secdev advisory | Experimental |
| Text | yes | none required | lint, types, security, graph | none wired | gitnexus, secdev advisory | Experimental |

**What this means:**
- **First-class** (TypeScript, JavaScript, Python): Required verifier slots run real tooling. Correction prompts reference concrete linters and type checkers. Host task validators remain authoritative for pass/fail.
- **Partial** (Shell): Security is required but tool coverage is limited. Host validators should supplement verification.
- **Experimental** (C/C++, Rust, Go, SQL, Text): Emission schemas route artifacts and prompt hints correctly, but no external linter/type-checker emitters are wired. Verification defaults to fail-closed on missing signals. Host task validators are essential; verifier pass should not be treated as task pass.

## v1 release candidate status

This is **v1.0.0-rc1**, not final v1. The plugin contract, verifier preflight, and native validator hook are implemented and tested. Native validator evidence now exists; broader model-quality evidence is still limited and mixed.

| Capability | Status | Notes |
|------------|--------|-------|
| Plugin contract (verify, prompt, observe, recall, doctor, decompose) | ✅ Implemented | Shell adapter and Node library both working |
| Task decomposition & dependency-graph execution | ✅ Implemented | `decompose`, `decompose --execute`, `recall-decomposition` |
| Verifier preflight | ✅ Implemented | Detects missing Python tools before spending model tokens |
| Native task validator hook | ✅ Implemented | `--validator` flag, `FinalVerdict`, `SourceOfTruth`, `taskPass` tri-state |
| Benchmark model-quality evidence | 🟡 Limited | Native validator smoke passed; the longer `.225` RNJ run exposed a 1/18 negative result. Treat current reports as routing-memory evidence, not a leaderboard. |
| Bundled local validator demo | 🟡 Optional | See `examples/validator-task/` for a minimal deterministic validator |

**No broad model-comparison claims should be made from the current benchmark reports.** Some older runs are infrastructure audits with `taskValidation.status: "skipped"`. Newer native-validator runs provide real pass/fail signal, including negative evidence. Treat them as routing-memory evidence until the same task panel is rerun across multiple workers. See the [benchmark evidence index](bench/results/README.md) for labels.

## v1 boundary

55NDeep v1 is a **deterministic verification, correction, and routing plugin** for existing coding CLIs. It is not a full autonomous agent.

Key boundaries:
- **Host task validators are authoritative.** `observe --outcome` must come from the host's own validator, never from `verification.overall` or `finalAction`.
- **First-class language coverage is TypeScript and Python, with JavaScript supported through the TS/JS verifier path.** Other languages have emission schemas and partial verifier wiring, but external linter/type-checker availability varies.
- **Memory is file-backed empirical routing** (JSON via `--memory`). Not SQL, not vector search. Suitable for single-user and small-team use.
- **v1 does not ship language servers, compilers, or package managers.** External tools (eslint, tsc, ruff, pyright, bandit) must be installed by the host environment.
- **Verifier signals default to fail-closed.** Missing linters or type checkers produce error status, not silent pass.
- **Missing-validator runs are infrastructure audits, not model comparisons.** When `taskValidation.status` is `"skipped"`, the task outcome is unknown — not failed. `taskPass` is `null`, not `false`.

## Quick start

```bash
npm install
npm run build
npm test

# Probe available tools
npx tsx apps/cli/src/index.ts doctor --pretty

# Verify a workspace (no model call)
npx tsx apps/cli/src/index.ts verify-workspace --workspace /path/to/project

# Build correction prompt from a verification result
npx tsx apps/cli/src/index.ts prompt --packet result.json

# Record a task observation
npx tsx apps/cli/src/index.ts observe --memory mem.json \
  --task-id t1 --description "fix auth" --language typescript \
  --mode hard-prompt --model gpt-4 --outcome pass --duration-ms 5000

# Recall routing bias
npx tsx apps/cli/src/index.ts recall --memory mem.json --description "fix auth"
```

## Design invariants

- **No model calls** in any verification or correction-prompt path. All five commands are deterministic.
- **stdout is data, stderr is diagnostics.** Hosts parse stdout; stderr is for humans.
- **Verifier fail is not exit 1.** The `ReducedStatePacket` is the product regardless of verdict. Only catastrophic failures produce exit 1.
- **Memory is explicit.** `observe` and `recall` require `--memory <path>`. No ambient state.
- **Host decides task outcome.** `observe --outcome` must come from the host's own task validator, never from `verification.overall` or `finalAction`. Verifier pass ≠ task pass. Recording verifier status as task outcome would poison routing memory with false positives.
- **Doctor distinguishes internal from external tools.** SecDev, GitNexus, and Graphify are bundled (always available, source: internal). ESLint, tsc, ruff, pyright, and bandit are probed from PATH (source: external).

## Architecture decisions

[ADR 001](docs/adr/001-deterministic-verification.md) — Deterministic verification outside the model
[ADR 002](docs/adr/002-event-driven-reducer.md) — Event-driven reduction for state convergence
[ADR 003](docs/adr/003-language-aware-contracts.md) — Language-aware emission contracts
[ADR 004](docs/adr/004-memory-routing-engine.md) — Memory as weighted pass-rate routing
[ADR 005](docs/adr/005-cheap-worker-thesis.md) — Verification commoditizes model choice

## Clean repo validation

```bash
bash scripts/ci.sh
# or: npm run ci
```

Runs `npm ci`, `build`, `lint`, `test`, and `test:adapter` in sequence. Exits on first failure. Use this to verify a fresh checkout is green end-to-end.

`npm ci` removes and recreates `node_modules` and must be run from the repository root so workspace links in `package-lock.json` resolve correctly.

## Requirements

- Node.js >= 20
- Git (for gitnexus diff tracking)
- Optional: ESLint, TypeScript, ruff, pyright, bandit (for language-specific verification)
