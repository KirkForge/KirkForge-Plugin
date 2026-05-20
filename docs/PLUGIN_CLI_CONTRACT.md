# 55NDeep Shell Adapter Contract

> Stable contract for host CLIs integrating via the shell command adapter.

The `55ndeep` CLI binary is a **shell adapter and reference runner**, not the product itself. The product is the deterministic verification, correction, and routing logic. Any host that can parse JSON from a subprocess can integrate.

## General rules

| Rule | Detail |
|------|--------|
| **stdout is machine-readable** | All commands emit JSON unless `--pretty` is specified (`doctor` only). Hosts parse stdout, never read stderr for data. |
| **stderr is human-readable** | Error messages, diagnostic text, and warnings go to stderr. |
| **Exit code 0 = data produced** | The command wrote valid output to stdout. Verifier fail/warn is still exit 0 because the `ReducedStatePacket` is the product. |
| **Exit code 1 = catastrophic failure** | The command could not produce its primary output. Examples: missing required args, file read failure, plugin initialization failure, memory store errors. |
| **No model calls** | None of these commands invoke an LLM. They are deterministic. |

### Host validator authority

The host CLI is the authority on task outcomes. `observe --outcome` must come from the host's own task validator or human judgment, never from `verification.overall` or `finalAction`. The shell adapter contract encodes this: the host provides `--outcome`, the plugin never infers it.

---

## Commands

### `55ndeep doctor`

Probe local verification tools and report capabilities.

```sh
55ndeep doctor            # compact JSON
55ndeep doctor --pretty   # human-readable table
```

**Output (JSON)**

```json
{
  "eslint": { "available": true, "version": "v9.1.0", "source": "external" },
  "tsc": { "available": false, "source": "external" },
  "ruff": { "available": false, "source": "external" },
  "pyright": { "available": false, "source": "external" },
  "bandit": { "available": false, "source": "external" },
  "secdev": { "available": true, "source": "internal" },
  "gitnexus": { "available": true, "source": "internal" },
  "graphify": { "available": true, "source": "internal", "note": "TS/JS graph support; advisory on other languages" },
  "languages": ["typescript"]
}
```

External tools (eslint, tsc, ruff, pyright, bandit) are probed from PATH. Internal tools (secdev, gitnexus, graphify) are bundled with 55NDeep and always available.

Language support varies. See the [Language support matrix](../README.md#language-support-matrix) for required vs. advisory verifier slots and v1 status per language.

**Exit codes**: 0 on success, 1 on catastrophic failure.

---

### `55ndeep verify-workspace`

Run deterministic verification on a workspace directory and emit a `ReducedStatePacket`.

```sh
55ndeep verify-workspace --workspace /path/to/project [--file a.ts b.ts] [--language typescript] [--task-id id]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--workspace` | yes | Path to the project root |
| `--file` | no | Specific files to verify (repeatable) |
| `--language` | no | Language hint (defaults to `typescript`) |
| `--task-id` | no | Task identifier for event correlation |

**Output**: Compact JSON `ReducedStatePacket` to stdout.

**Exit codes**: 0 for all verifier results (pass, warn, fail, error, skipped). The packet is the product. Exit 1 only for catastrophic plugin failures where no packet can be produced.

A workspace path that does not exist still exits 0 — the packet will contain `overall: "fail"` with verifier error details in their respective slots.

---

### `55ndeep prompt`

Build a correction prompt from a `ReducedStatePacket` JSON file.

```sh
55ndeep prompt --packet result.json [--language typescript]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--packet` | yes | Path to a `ReducedStatePacket` JSON file |
| `--language` | no | Language for tool name resolution |

**Output**: Plain text correction prompt to stdout.

**Exit codes**: 0 on success, 1 on file read failure, invalid JSON, or prompt construction failure.

**stdout is reserved**: The correction prompt goes to stdout with no other output. Errors go to stderr.

---

### `55ndeep observe`

Record a task observation to a memory store file.

```sh
55ndeep observe \
  --memory /path/to/mem.json \
  --task-id t1 \
  --description "fix auth bug" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome pass \
  --duration-ms 5000 \
  [--tokens 1200]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--memory` | yes | Path to the memory store file |
| `--task-id` | yes | Task identifier |
| `--description` | yes | Task description |
| `--language` | yes | Task language |
| `--mode` | yes | Delegation mode (`hard-prompt`, `ts-contract`, `artifact`) |
| `--model` | yes | Worker model used |
| `--outcome` | yes | Result: `pass`, `fail`, or `escalate` |
| `--duration-ms` | yes | Wall-clock time in milliseconds (non-negative integer) |
| `--tokens` | no | Token cost (non-negative integer) |

**Output**: Compact JSON to stdout:

```json
{ "ok": true, "taskId": "t1", "outcome": "pass" }
```

**Exit codes**: 0 on success, 1 on missing/invalid args or memory store failure.

---

### `55ndeep recall`

Recall routing bias from past observations.

```sh
55ndeep recall --memory /path/to/mem.json --description "fix auth bug" [--model gpt-4]
```

| Flag | Required | Description |
|------|----------|-------------|
| `--memory` | yes | Path to the memory store file |
| `--description` | yes | Task description to match |
| `--model` | no | Worker model to filter by |

**Output**: Compact JSON to stdout:

```json
{ "ok": true, "bias": { "prefer": [...], "avoid": [...], "confidence": 0.85, "influence": 0.7, "evidence": 3, "similarCases": [...] } }
```

When no matching observations exist:

```json
{ "ok": true, "bias": null }
```

**Exit codes**: 0 on success (including no-match), 1 on missing args or memory store failure.

---

### `55ndeep decompose`

Break a complex task into smaller, independently verifiable subtasks using a dedicated planning model. This is the only command in the contract that invokes an LLM.

```sh
55ndeep decompose "Build a REST API with auth and rate limiting"
55ndeep decompose "Build a REST API with auth and rate limiting" --json
55ndeep decompose "Build a REST API with auth and rate limiting" --execute
```

| Flag | Required | Description |
|------|----------|-------------|
| `<description>` | yes | Task description to decompose |
| `--json` | no | Output structured JSON instead of human-readable summary |
| `--execute` | no | Execute the decomposed subtasks in dependency order after decomposition |
| `--provider` | no | Provider key from config (overrides `decomposeProvider` in model config) |

**Output (human-readable)**:

```
Decomposed "Build a REST API with auth" into 5 subtasks:
Rationale: Decomposed into 5 subtasks (3 with dependencies)
Estimated tokens: ~2500

  [setup-ts] simple | typescript
    Initialize TypeScript project with Express and middleware
    → package.json, tsconfig.json, src/index.ts

  [auth-module] moderate | typescript (needs: setup-ts)
    Implement JWT authentication with login/refresh endpoints
    → src/auth.ts, src/middleware/auth.ts
    ✓ Verify: POST /login returns token, POST /refresh returns new token

  [rate-limit] simple | typescript (needs: setup-ts)
    Add rate limiting middleware with configurable window
    → src/middleware/rate-limit.ts
    ✓ Verify: 6th request within window returns 429

  [routes] moderate | typescript (needs: auth-module, rate-limit)
    Wire protected routes and integrate middleware
    → src/routes.ts

  [tests] simple | typescript (needs: routes)
    Add integration tests for auth flow and rate limiting
    → src/__tests__/api.test.ts
```

**Output (JSON, `--json`)**:

```json
{
  "rootTask": "Build a REST API with auth and rate limiting",
  "tasks": [
    {
      "id": "setup-ts",
      "description": "Initialize TypeScript project with Express and middleware",
      "language": "typescript",
      "dependsOn": [],
      "estimatedComplexity": "simple",
      "outputFiles": ["package.json", "tsconfig.json", "src/index.ts"],
      "verificationHint": ""
    }
  ],
  "totalEstimatedTokens": 2500,
  "rationale": "Decomposed into 5 subtasks (3 with dependencies)"
}
```

**Output (`--execute`, JSON mode)**:

```json
{
  "rootTask": "Build a REST API with auth and rate limiting",
  "results": [
    { "nodeId": "setup-ts", "ok": true, "description": "Initialize TypeScript project...", "language": "typescript", "durationMs": 3421, "tokensUsed": 450, "verdict": "pass", "files": ["package.json", "tsconfig.json", "src/index.ts"] },
    { "nodeId": "auth-module", "ok": true, "description": "Implement JWT authentication...", "language": "typescript", "durationMs": 5234, "tokensUsed": 780, "verdict": "pass", "files": ["src/auth.ts", "src/middleware/auth.ts"] }
  ],
  "totalSubtasks": 5,
  "succeededCount": 5,
  "failedCount": 0,
  "totalTokens": 3800,
  "totalDurationMs": 45000
}
```

**Exit codes**: 0 on success, 1 on decomposition failure or execution failure (with `--execute`).

**Subtask execution** (`--execute`): Each subtask is delegated in dependency order. Failed dependencies propagate — children of failed subtasks are skipped with `"error": "Skipped: dependency X failed"`. Each subtask gets one automatic retry on failure and a 5-minute timeout. The full execution result includes per-node status, tokens, duration, verdict, and output files.

### `55ndeep recall-decomposition`

Recall a previously stored task decomposition from memory.

```sh
55ndeep recall-decomposition "<task-id-or-description>"
55ndeep recall-decomposition "<task-id-or-description>" --json
```

| Flag | Required | Description |
|------|----------|-------------|
| `<task-id-or-description>` | yes | Task ID or description substring to search for |
| `--json` | no | JSON output |

**Output (human-readable)**:

```
Decomposition for "Build a REST API with auth" (stored 2026-05-20T10:00:00.000Z):
5 subtasks:

  [setup-ts] simple | typescript
    Initialize TypeScript project with Express and middleware
    → package.json, tsconfig.json, src/index.ts

  [auth-module] moderate | typescript (needs: setup-ts)
    Implement JWT authentication with login/refresh endpoints
    → src/auth.ts, src/middleware/auth.ts
    ✓ Verify: POST /login returns token, POST /refresh returns new token
```

**Exit codes**: 0 on success (including no-match), 1 on memory store failure.

**Memory store**: Uses the same `--memory` file as `observe` and `recall`. Decompositions are stored automatically by `decompose` and retrieved by `recall-decomposition`. The search performs substring matching against stored task descriptions and returns the first match.

---

## Host integration sequence

The minimal integration loop for a host CLI:

```
1. Host writes generation output to workspace
2. Host calls: 55ndeep verify-workspace --workspace /path
3. Parse ReducedStatePacket from stdout
4. If overall != "pass":
     a. Host calls: 55ndeep prompt --packet result.json
     b. Parse correction prompt from stdout
     c. Host feeds prompt back into its model loop
     d. Host retries from step 1
5. After task resolves (pass/fail/escalate):
     Host calls: 55ndeep observe --memory mem.json ...
6. On future tasks:
     Host calls: 55ndeep recall --memory mem.json --description "..."
     Uses routing bias to select mode/model
```

### Generic host hook sketch

This is a shell-contract sketch, not an installed integration; `TASK_ID`, `TASK_DESC`, `TASK_OUTCOME`, and `ELAPSED_MS` are host-provided placeholders.

```sh
#!/usr/bin/env bash
set -euo pipefail

WORKSPACE="$1"

# Step 1: verify
PACKET=$(55ndeep verify-workspace --workspace "$WORKSPACE" --language typescript)
echo "$PACKET" > result.json

# Step 2: check overall
OVERALL=$(echo "$PACKET" | jq -r '.verification.overall')

if [ "$OVERALL" != "pass" ]; then
  # Step 3: get correction prompt
  PROMPT=$(55ndeep prompt --packet result.json --language typescript)
  echo "Correction needed:"
  echo "$PROMPT"
  # Host would feed $PROMPT back into its model loop
fi

# Step 4: record observation
# TASK_OUTCOME is host-provided (pass/fail/escalate), not derived from verifier.
# The host decides whether the task actually succeeded.
55ndeep observe \
  --memory ./55ndeep-memory.json \
  --task-id "$TASK_ID" \
  --description "$TASK_DESC" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome "$TASK_OUTCOME" \
  --duration-ms "$ELAPSED_MS"
```

---

## Host outcome is authoritative

`observe --outcome` records whether the **task** succeeded, not whether the **verifier** passed. These are different signals:

| Scenario | `verify-workspace` overall | Host task result | Correct `--outcome` |
|----------|---------------------------|-------------------|---------------------|
| Code passes all checks and task tests pass | `pass` | pass | `pass` |
| Verifier reports lint/type errors but task tests pass | `fail` | pass | `pass` |
| Verifier passes but task tests fail | `pass` | fail | `fail` |
| Validator missing or infrastructure error | any | unknown | `escalate` |

**The host must provide `--outcome` from its own task validator or judgment, never from `ReducedStatePacket.verification.overall` or `finalAction`.**

Why this matters: recording verifier pass as task outcome poisons routing memory with false positives. A task can pass all code-quality checks but still produce wrong output, and vice versa.

Common anti-patterns to avoid:

```sh
# WRONG: deriving outcome from verifier status
OUTCOME=$(echo "$PACKET" | jq -r '.verification.overall')
55ndeep observe --outcome "$OUTCOME" ...

# WRONG: deriving outcome from correction-loop final action
OUTCOME="$FINAL_ACTION"
55ndeep observe --outcome "$OUTCOME" ...

# CORRECT: outcome from host task validator
if test_suite_passes; then
  OUTCOME="pass"
elif test_suite_fails; then
  OUTCOME="fail"
else
  OUTCOME="escalate"
fi
55ndeep observe --outcome "$OUTCOME" ...
```

---

## Design invariants

1. **Deterministic core**. `doctor`, `verify-workspace`, `prompt`, `observe`, `recall`, and `recall-decomposition` run local tooling only with no model calls. `decompose` and `decompose --execute` are the only commands that invoke an LLM (for task planning and subtask delegation).
2. **stdout is data, stderr is diagnostics.** Hosts parse stdout; stderr is for humans.
3. **Verifier fail is not exit 1.** The `ReducedStatePacket` is the product regardless of overall verdict. Only catastrophic failures (no packet producible) produce exit 1.
4. **Memory is explicit.** `observe` and `recall` require `--memory <path>`. No ambient state, no global config.
5. **`observe` maps `escalate` to `fail`.** The memory layer stores escalate outcomes as fail for routing bias purposes.
6. **Task validators are separate from the verifier battery.** `observe --outcome` should be derived from `TaskValidationResult` or an equivalent host decision, never from `ReducedStatePacket.verification.overall`. See `taskOutcomeFromValidation()` in `@55ndeep/correction-core`.
7. **The shell adapter is a reference runner, not the product.** The deterministic verification, correction, and routing logic is the product. The `55ndeep` binary is one way to access it.
