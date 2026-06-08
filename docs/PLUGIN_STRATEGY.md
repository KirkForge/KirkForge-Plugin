# KirkForge Plugin Strategy

> KirkForge is not a standalone agent framework. It is a deterministic delegation plugin for coding agents — a verification, correction, and empirical routing layer that plugs into Codex, Claude Code, OpenCode, LangChain-style systems, and internal agent stacks.

## 1. Product boundary

### What KirkForge owns

| Domain                           | Responsibility                                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace/file verification**  | Run lint, type-check, security, git-diff, and import-graph emitters. Produce a single pass/warn/fail verdict per task turn.                                                                                             |
| **Fail-closed reduced state**    | Merge language-specific verifier signals (TypeScript battery: ESLint, tsc, secdev, gitnexus, graphify; Python battery: ruff, pyright, bandit, gitnexus) into one `ReducedStatePacket`. Missing signal defaults to fail. |
| **Correction prompt generation** | Given a `ReducedStatePacket` and task context, build a compact prompt that tells the host CLI exactly what to fix.                                                                                                      |
| **Empirical routing memory**     | Record task observations, recall past routing bias (mode, model, confidence), and recommend delegation strategies based on cosine-similarity of task fingerprints.                                                      |
| **Benchmark/audit reports**      | Produce JSON and Markdown reports comparing models, modes, and task outcomes. This is evidence infrastructure for evaluating the plugin's effectiveness, not product surface.                                           |

### What host CLIs own

| Domain                          | Responsibility                                          |
| ------------------------------- | ------------------------------------------------------- |
| **Chat UX**                     | Session display, streaming, user prompts                |
| **Model auth**                  | API keys, provider login, token refresh                 |
| **Model/tool loop**             | Multi-turn generation, retry, tool calls                |
| **File editing**                | Writing changes to disk, undo/redo                      |
| **User approval flow**          | Confirming, rejecting, or modifying proposed changes    |
| **Terminal/session management** | Shell integration, working directory, process lifecycle |

The boundary is deliberate. KirkForge never calls a model during verification. It never writes to the user's project workspace during verification. It may persist memory and audit observations through `recordObservation` to its own data directory. It never authenticates with a provider. It returns structured data and lets the host decide what to do next.

---

## 2. Plugin flow

```
host CLI delegates task → worker model emits files
  → KirkForge verifies workspace/run dir
  → KirkForge returns ReducedStatePacket
  → KirkForge builds compact correction prompt (if needed)
  → host CLI retries/escalates
  → KirkForge records observation
```

Detailed:

1. The host CLI (Codex, Claude Code, OpenCode) finishes a generation turn and has written files to disk.
2. The host calls `verifyWorkspace({ workspace, files, language? })`.
3. KirkForge runs the language-appropriate verifier battery in parallel. For TypeScript, this is ESLint, tsc, secdev, gitnexus, and graphify; for Python, ruff, pyright, bandit, and gitnexus. No model calls occur.
4. The `StateReducer` folds all signals into one `ReducedStatePacket` (defined in `@kirkforge/correction-core`) with an overall `pass | warn | fail` verdict.
5. If the verdict is not `pass`, the host can call `buildCorrectionPrompt(packet, context)` (from `@kirkforge/correction-core`) to get a compact prompt describing exactly what failed and where.
6. The host feeds that prompt into its own model loop for a retry.
7. After the task resolves (pass, fail, or escalate), the host calls `recordObservation(observation)` so that future similar tasks can benefit from empirical routing.

### Brain, Brawn, Verifier

The plugin flow maps to a three-role model:

- **Brain** (expensive): The orchestrator — the host CLI or correction loop controller that plans, delegates, and decides next action.
- **Brawn** (cheap): The worker model that generates code from prompts.
- **Verifier** (free): KirkForge — deterministic state inspection. No model calls.

This framing makes clear that KirkForge is the Verifier role. It does not compete with the Brain or the Brawn; it makes both more effective by catching deterministic failures before they consume another model turn.

---

## 3. Stable API surface

These APIs are documented as a contract. Each entry is tagged with its current stability rating (Stable / Beta / Experimental) per `docs/STABILITY_MATRIX.md`.

### `verifyWorkspace(input) -> ReducedStatePacket` — **Stable**

**Purpose** — Run the deterministic verification battery on a workspace directory. This is the primary entry point.

**Input fields**

| Field       | Type       | Required | Description                                              |
| ----------- | ---------- | -------- | -------------------------------------------------------- |
| `workspace` | `string`   | yes      | Absolute path to the project root                        |
| `files`     | `string[]` | no       | Subset of files to verify; defaults to all changed files |
| `language`  | `string`   | no       | Primary language hint (`"typescript"`, `"python"`, etc.) |
| `taskId`    | `string`   | no       | Task identifier for event correlation                    |

**Output fields** — [`ReducedStatePacket`](../packages/correction-core/src/types.ts)

| Field                 | Type                 | Description                                                         |
| --------------------- | -------------------- | ------------------------------------------------------------------- |
| `taskId`              | `string`             | Correlation ID                                                      |
| `turn`                | `number`             | Turn ordinal within the task                                        |
| `ts`                  | `number`             | Epoch ms                                                            |
| `driftScore`          | `number?`            | Optional drift metric                                               |
| `changes`             | `StateChangesEvent?` | Git-diff signal                                                     |
| `graph`               | `StateGraphEvent?`   | Import-graph signal                                                 |
| `verification`        | `object`             | `{ lint, types, security, overall }` — per-verifier status + detail |
| `contributingSignals` | `ReducerSignal[]`    | Raw event list for audit                                            |

**Failure behavior** — Returns a `ReducedStatePacket` with `overall: "fail"` or `"warn"`. Never throws on verifier error; individual emitter errors become `"error"` status in their slot, which the reducer treats as fail.

**May call a model?** — **No.** Verification is entirely deterministic. This invariant must hold for all verifier emitters.

---

### `buildCorrectionPrompt(packet, context) -> string` — **Stable**

**Purpose** — Given a failed verification packet, build a compact correction prompt targeting the specific failures.

**Input fields**

| Field     | Type                 | Required | Description                                                 |
| --------- | -------------------- | -------- | ----------------------------------------------------------- |
| `packet`  | `ReducedStatePacket` | yes      | The verification result to correct                          |
| `context` | `object`             | no       | `{ language?, format? }` — language and prompt format hints |

**Output** — Plain text string containing the correction prompt. No model calls.

**May call a model?** — **No.** Correction prompts are template-driven from verification failures.

---

### `recordObservation(observation) -> void` — **Stable**

**Purpose** — Record a task outcome for future routing. The host must provide the actual task outcome (pass/fail/escalate), not the verifier verdict.

**Key constraint** — The `outcome` field must come from a host task validator or human judgment, never from `ReducedStatePacket.verification.overall`. Recording verifier pass as task outcome poisons routing memory with false positives.

**May call a model?** — **No.** Memory writes are file-backed JSON.

---

### `recallRoutingBias(description, model?) -> Recommendation | null` — **Stable**

**Purpose** — Look up past observations for similar tasks and return a routing recommendation.

**Input fields**

| Field         | Type     | Required | Description               |
| ------------- | -------- | -------- | ------------------------- |
| `description` | `string` | yes      | Task description to match |
| `model`       | `string` | no       | Worker model to filter by |

**Output** — `Recommendation` with mode, model, confidence, evidence, and routing bias, or `null` if no similar tasks found.

**May call a model?** — **No.** Similarity is cosine-similarity on fingerprint vectors, computed locally.

---

### `doctor() -> ToolCapabilityReport` — **Stable**

**Purpose** — Probe local verification tools and report what is available.

**Output fields**

| Field       | Type                             | Description                                |
| ----------- | -------------------------------- | ------------------------------------------ |
| `tools`     | `Record<string, ToolCapability>` | Per-tool availability, version, and source |
| `languages` | `string[]`                       | Detected languages                         |

**May call a model?** — **No.** Probes local PATH for external tools, checks bundled internal tools.

### `createAuthMiddleware(config) -> AuthMiddleware` — **Beta**

**Purpose** — Build an auth middleware that authenticates `Bearer` tokens (OIDC JWT or static API key) and resolves them to an `Actor` for RBAC checks. Used when the host wants to expose KirkForge over HTTP or MCP and gate the verifier calls behind authentication.

**Input fields**

| Field                         | Type               | Description                                                                  |
| ----------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `oidcConfig`                  | `OidcConfig`       | JWKS URI, issuer, audience. Verified on every request.                      |
| `apiKey`                      | `string`           | Static bearer fallback. ≥ 32 chars enforced in enterprise mode.             |
| `groupRoleMapping`            | `GroupRoleMapping` | OIDC group claims → role mapping.                                            |
| `auditLogger`                 | `AuditLogger`      | Auth events recorded here.                                                   |
| `requireAuth`                 | `boolean`          | Default `false` in dev, `true` in enterprise.                                |
| `allowApiKeyFallbackWithOidc` | `boolean`          | Default `true` in dev, `false` in enterprise (no silent JWT→key downgrade). |

**Output** — `AuthMiddleware` with `authenticate(authorizationHeader)` and `checkPermission(actor, permission)` methods. Auth failures throw `AuthMiddlewareError` with a `statusCode` field.

**May call a model?** — **No.**

**Stability note** — The role/permission model is shared with `core-rbac` and may evolve as enterprise integrations grow. The middleware shape (constructor config + two methods + one error class) is the stable contract.

### `createTenantContext(config) -> Promise<TenantContext>` — **Beta**

**Purpose** — Initialize a fully-wired multi-tenant context with isolated memory store, tenant-scoped audit logger, and optional quota manager. Used when the host runs a SaaS or team deployment.

**May call a model?** — **No.** All initialization is local I/O (registry, memory store, audit sink).

**Stability note** — The `TenantContext` shape is stable; the underlying `TenantRegistry` API may shift.

### `createAuthAuditHook(audit, defaultTenantId?) -> (decision) => void` — **Stable**

**Purpose** — Bridge `core-rbac` `AuthDecision` objects into the `AuditLogger`. Used to make every authorization decision (whether granted or denied) end up in the WORM audit log.

**May call a model?** — **No.** Pure function wrapper over `audit.record()`.

---

## 4. What it is not

KirkForge explicitly does **not** aim to:

- **Replace Codex, Claude Code, or OpenCode.** KirkForge is a verification and routing layer they call, not a competitor.
- **Build a full chat client.** The host owns the UX, session, and display.
- **Own provider auth long term.** Model configuration is the host's responsibility. KirkForge may accept a model config for correction-prompt token estimation, but it will never store or refresh API keys.
- **Treat memory as persona/prompt mythology.** Memory observations are empirical records of what mode and model worked for similar tasks, not personality injection.
- **Accept verifier success as benchmark success.** `verifyWorkspace` returning `pass` does not mean the task is done. Task validators, provided by the host, are the authority on task completion.
- **Claim cheap models beat frontier models.** The claim is cost-reduced delegation through deterministic emissions, not that small models beat frontier models. Verification makes any model's output more reliable. It does not make a smaller model produce better code than a larger one on open-ended tasks. The value is in deterministic state inspection, not in model comparison.

---

## 5. Adapter layers

### Shell command adapter (any host)

The host calls the `kirkforge` CLI binary as a subprocess. No Node dependency in the host. The host pipes JSON between calls.

```sh
# verify workspace
kirkforge verify-workspace --workspace /path/to/project

# build correction prompt if needed
kirkforge prompt --packet result.json

# record task outcome (host-provided)
kirkforge observe --memory mem.json --task-id t1 --description "fix auth" \
  --language typescript --mode hard-prompt --model gpt-4 \
  --outcome pass --duration-ms 5000

# recalls routing bias
```

See [PLUGIN_CLI_CONTRACT.md](./PLUGIN_CLI_CONTRACT.md) for the full command reference, stdout/stderr/exit code rules, and host integration examples.

Requires no Node dependency in the host. The host pipes JSON between calls. Suitable for Codex, Claude Code, or any CLI that can parse JSON from a subprocess.

### Node library adapter

The host imports KirkForge as a Node package:

```ts
import {
  verifyWorkspace,
  buildCorrectionPrompt,
  recordObservation,
  recallRoutingBias,
  doctor,
} from "@kirkforge/plugin";

const packet = await verifyWorkspace({ workspace: "/path/to/project", files: ["changed.ts"] });
const prompt = buildCorrectionPrompt(packet, { language: "typescript" });
recordObservation({ taskDescription: "fix auth bug", mode: "ts-contract", outcome: "pass" });
const bias = await recallRoutingBias({ taskDescription: "fix auth bug" });
const report = await doctor();
```

Suitable for OpenCode, any Node-based CLI, or Electron-based tools.

### Native plugin adapter

The host mounts KirkForge as a first-class plugin with lifecycle hooks:

```ts
// In the host's plugin registration
host.registerVerificationPlugin({
  name: "kirkforge",
  onFileChange: async (files) => verifyWorkspace({ workspace, files }),
  onTaskComplete: async (task) => recordObservation(task),
  onTaskStart: async (task) => recallRoutingBias(task),
});
```

Requires the host to support a plugin protocol. Not yet implemented; documented as a target.

### Likely hosts

| Host        | Integration path                      | Status              |
| ----------- | ------------------------------------- | ------------------- |
| Codex       | Shell command adapter                 | Not yet implemented |
| Claude Code | Shell command adapter                 | Not yet implemented |
| OpenCode    | Node library adapter or native plugin | Not yet implemented |

None of these integrations exist yet. This document defines the target surface; extraction and adapter work is on the roadmap.

---

## 6. Roadmap

| PR    | Description                                                                                                                                                                                                       | Status |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| PR 4  | Extract `plugin` package from existing orchestrator, reducer, verifier, and memory code. Define the stable API surface described in §3.                                                                           | Done   |
| PR 5  | Add `doctor()` / `ToolCapabilityReport` to `plugin` and CLI command `kirkforge doctor`.                                                                                                                           | Done   |
| PR 6  | Add `kirkforge prompt --packet` CLI command.                                                                                                                                                                      | Done   |
| PR 7  | Add `kirkforge observe` CLI command with `--memory` path.                                                                                                                                                         | Done   |
| PR 8  | Add CLI subprocess tests for doctor, prompt, and observe (stdout, stderr, exit codes).                                                                                                                            | Done   |
| PR 9  | Add `kirkforge recall` CLI command. Completes minimal memory loop: observe → recall.                                                                                                                              | Done   |
| PR 10 | Add `kirkforge verify-workspace` CLI command. Completes shell adapter surface.                                                                                                                                    | Done   |
| PR 11 | Document plugin CLI contract. See [PLUGIN_CLI_CONTRACT.md](./PLUGIN_CLI_CONTRACT.md).                                                                                                                             | Done   |
| PR 12 | Add runnable shell adapter example with `--outcome` arg and `require_value` guard.                                                                                                                                | Done   |
| PR 13 | Update README to reference plugin strategy and clarify plugin-not-framework positioning.                                                                                                                          | Done   |
| PR 20 | Extract `@kirkforge/correction-core` — single source of truth for `toolNames`, `buildCorrectionPrompt`, `ReducedStatePacket`, `TaskLanguage`.                                                                     | Done   |
| PR 25 | Add `TaskValidationResult`, `TaskOutcome`, `taskOutcomeFromValidation`, `isTaskPass`, `makeSkippedValidation` to correction-core.                                                                                 | Done   |
| PR 26 | Add `normalizeTaskValidation()` and `makeBenchmarkRow()` in correction-core for bench-side task validator adapter.                                                                                                | Done   |
| PR 34 | Extract `EmissionSchema` type — the shared source for artifact rules, prompt hints, and verifier policy. `TaskProfile` is now an alias of `EmissionSchema`.                                                       | Done   |
| PR 35 | Add host/task outcome guardrails — contract docs, anti-patterns, adapter test assertions protecting against `OUTCOME=$OVERALL` regression.                                                                        | Done   |
| PR 36 | Make `doctor()` distinguish internal owned tools from external installed tools. `ToolCapability` gains `source`, `required`, `note` fields. SecDev/GitNexus/Graphify no longer probed via `node -e require(...)`. | Done   |
| PR 37 | Document language support matrix and v1 boundary. First-class/Partial/Experimental tiers, v1 scope limits, host validator authority.                                                                              | Done   |
| PR 42 | Add benchmark verifier preflight — detect missing Python tools before spending model tokens. `verifierPreflight` field in report JSON.                                                                            | Done   |
| PR 47 | Add native task validator verdicts to correction loop — `--validator` flag, `FinalVerdict`, `SourceOfTruth`, `taskPass` as true/false/null.                                                                       | Done   |
| PR 49 | Recenter documentation around plugin product identity. Brain/Brawn/Verifier framing, benchmark as evidence infrastructure, CLI as shell adapter.                                                                  | Done   |
| PR 50 | Rename public plugin package from `@kirkforge/plugin-core` to `@kirkforge/plugin`. Folder rename, all imports updated.                                                                                            | Done   |
| PR 51 | Post-`@kirkforge/plugin` rename validator benchmark. 4 tasks × 4 workers. All 16 cells `missing-validator`. Infra audit, not model quality.                                                                       | Done   |
| PR 52 | Validator-capable task inventory and benchmark `taskPass` tri-state fix. No validator-capable tasks found on current host.                                                                                        | Done   |
| PR 53 | Prepare v1 release evidence documentation. RC status, evidence index, roadmap update, local validator example.                                                                                                    | Done   |

---

## 7. Non-goals

KirkForge explicitly does **not** aim to:

- **Replace Codex, Claude Code, or OpenCode.** KirkForge is a verification and routing layer they call, not a competitor.
- **Build a full chat client.** The host owns the UX, session, and display.
- **Own provider auth long term.** Model configuration is the host's responsibility. KirkForge may accept a model config for correction-prompt token estimation, but it will never store or refresh API keys.
- **Treat memory as persona/prompt mythology.** Memory observations are empirical records of what mode and model worked for similar tasks, not personality injection.
- **Accept verifier success as benchmark success.** `verifyWorkspace` returning `pass` does not mean the task is done. Task validators, provided by the host, are the authority on task completion.
