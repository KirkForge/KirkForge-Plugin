## Unreleased (v7-dev)

### Task decomposition & execution engine
- **decompose CLI command**: Breaks complex tasks into smaller, independently verifiable subtasks using a dedicated planning model. Returns a topologically sorted dependency tree with complexity estimates and token projections.
- **executeDecomposition**: New orchestrator method walks the sorted task tree, delegates each subtask in dependency order, propagates dependency failures (children of failed deps are skipped with clear error messages), and returns a structured `DecompositionExecutionResult` with per-node `SubtaskExecutionResult` entries.
- **`--execute` flag on decompose**: Chains decompose → execute in one command. Prints a compact summary with ✓/✗ status, tokens, duration, and output files per subtask. JSON mode serializes the full result.
- **`recall-decomposition` CLI**: Recalls previously stored decompositions from memory for inspection or re-execution.
- **DECOMPOSE_TEMPLATE**: Zod-validated prompt template (`@55ndeep/prompt-core`) with schema-contract response shaping. Validates `id`, `description`, `language`, `dependsOn`, `estimatedComplexity` (enum), `outputFiles`, and `verificationHint` at both template and parse time.
- **Defensive topological re-sort**: `executeDecomposition` re-sorts stored tasks before execution, guarding against corrupted or hand-edited memory stores. Cycle detection surfaces invalid dependency graphs.
- **Subtask retry & timeout**: Each delegate call gets one automatic retry on failure and a 5-minute per-subtask timeout via `Promise.race`.
- **Bracket heuristic**: Robust JSON extraction handles prose brackets, markdown code fences, nested `[DEPRECATED]` markers in strings, `src/[id]/page.tsx` paths, and whitespace-heavy model output. Fuzz-tested for edge cases.

### Hard-prompt emission ledger unification
- **extractEmissionFiles now handles `files.written`**: Hard-prompt emissions now enter the same canonical emission ledger as artifact emissions. Previously `extractEmissionFiles()` only read `artifact.emitted` signals, silently ignoring hard-prompt file writes in memory records.

### Provider semantics explicit
- **providerType field**: `ModelClientOptions` now accepts an explicit `providerType` field. `ModelClient.isAnthropic()` and `providerKey` derivation prefer this over brittle URL-substring matching. `Agent` constructor maps the existing `provider` config field to `providerType` automatically.

### Transactional run + emission writes
- **MemoryStore.writeRunAndEmissions()**: New method atomically persists a run record with its emission records. Guarantees no orphaned run records with missing emissions. Pre-computed emission IDs ensure ID consistency between run and emission records.

### Environment/config hygiene
- **Bootstrap no longer auto-loads `.env`/`.55ndeperc`**: Config loading is explicit. No implicit process.cwd file reads at import time. Removes a source of non-deterministic behavior.
- **ConfigService.load() no longer mutates `process.env`**: The `55NDEEP_CONFIG` key is no longer written to the global environment. Callers manage their own config path tracking.
- **ConfigService.getPath() workspace containment**: Now validates that resolved paths stay within the workspace directory, throwing on escape attempts.

### JSONL protocol tightening
- **Non-JSONL lines now break strict mode**: Lines that don't start with `{` or contain invalid JSON in a JSONL artifact stream now set `strictTermination = false`. Previously they were silently skipped, allowing prose intermixed with valid JSONL to pass protocol integrity checks.

### Smaller fixes
- **writeArtifacts() error preservation**: Write failures now include the exception message in the `blocked` field instead of silently dropping to `ok: false`.
- **EventBus idempotency**: Event ID derivation now includes timestamp to distinguish events with identical kind/streamId/sequence/payload combinations.

### Test results
- **Build**: Clean (`tsc --build` passes, `tsc --build --noEmit` passes)
- **Lint**: Clean (`eslint --max-warnings 0` passes)
- **Typecheck**: Clean
- **Individual test suites**: All pass (orchestrator 77, coverage 67, chaos 6, validator-contract 12, validator 12, memory 19, events 4, correction-core 48, model-client 7, model-config 6, core-logging 6, agent-core 2, secdev 4, prompt-core 5, result 10, plus fuzz tests).
- **Full `npm test`**: Requires external tool availability (eslint, tsc, ruff, pyright, bandit, git) for CLI/plugin integration tests. Verify in a full environment.



### Critical data-integrity fix
- **Hard-prompt beforeHash/existed corruption**: `persistCodeBlocks()` now snapshots `beforeHash` and `existed` BEFORE the atomic write, not after. Previously, all hard-prompt emissions recorded the after-write hash as `beforeHash` and `existed: true` unconditionally, corrupting emission audit data. Snapshots captured via `beforeHashSnapshots` Map before the atomic `renameSync`.

### Deployment fixes
- **Dockerfile**: Added missing `core-secrets` and `core-tenancy` manifest-layer COPY lines. Previously npm ci created broken workspace symlinks for these packages.
- **Dockerfile CMD**: Changed from `--help` to `serve` — container no longer exits immediately.
- **docker-compose**: Added explicit `command: ["serve"]` to prevent container exit loop.
- **CLI `serve` command**: New daemon command starts `HealthServer` and blocks until SIGTERM/SIGINT. Registers graceful shutdown hook on both signals. Health server properly transitions through `ready → not_ready → stop`.
- **HealthServer export**: Added `./health-server` export to `@55ndeep/orchestrator` package.json exports map.
- **`/metrics` endpoint**: Returns JSON-format stats (not Prometheus exposition). For Prometheus, use the OpenTelemetry OTLP pipeline (`OTEL_EXPORTER_OTLP_ENDPOINT`).
- **Helm configmap.yaml**: Added missing ConfigMap template that `deployment.yaml` referenced for checksum annotations.

### Test reliability
- **vitest pool**: Switched from `forks` to `threads` pool for faster, more reliable execution.
- **plugin path-safety test**: Updated "sanitizes file paths that escape workspace" to expect `ok: false` with descriptive error message, matching the implementation's hard-reject behavior.

# Changelog

## Unreleased (v8-dev)

### Memory transactional writes
- **SqliteAdapter.writeRunAndEmissions()**: New adapter-level method wraps run + emission writes in a SQL transaction (BEGIN IMMEDIATE / COMMIT / ROLLBACK). MemoryStore delegates to it when available, falling back to sequential writes for non-transactional adapters.
- **FileAdapter cross-process lock**: `flush()` acquires an exclusive file lock before writing. Note: concurrent processes that both load stale in-memory state before flushing can still lose each other's writes (read-modify-write across processes is not fully atomic). Sufficient for single-process daemon use; concurrent CLI automation should use SqliteAdapter.

### Protocol & validation hardening
- **JSONL base64 validation**: `content_b64` is now validated against canonical base64 regex before decoding. Invalid base64 triggers protocol violation.
- **JSONL unknown type detection**: JSON objects with unrecognized `type` fields (not `file_write`) now set `strictTermination = false` instead of being silently ignored.
- **JSONL empty-output handling**: When no JSONL artifacts are found and no JSONL-formatted lines exist in the output, returns `strictTermination: false` instead of `true`.
- **writeArtifacts() ordering**: Overwrite policy and denyPaths checks now run before reading `beforeHash`. `beforeHash` read is wrapped in try/catch with a descriptive `blocked` message on failure.

### Profile accuracy
- **Shell profile**: `checkCommand` corrected from `"bash -n && shellcheck -x"` to `"bash -n"` to match the actual `structuredCheck`.

### Config & path safety
- **Vault KV v2 path encoding**: Path segments are now individually URI-encoded, preserving `/` as path separators. Previously `encodeURIComponent()` on the full path encoded slashes, breaking Vault KV v2 lookup.
- **ConfigService.getPath()**: Uses `relative()` + `isAbsolute()` for workspace containment instead of POSIX-specific `startsWith()` prefix check.

### Provider disambiguation
- **ModelClient circuit breaker key**: Now includes baseUrl host when `providerType` is `"openai"` (or unset), disambiguating OpenRouter, Ollama, and other OpenAI-compatible providers that previously shared a single circuit breaker key.
- **ModelClient.isAnthropic()**: URL-substring fallback now logs a warning in non-production environments, nudging callers to set `providerType` explicitly.

### Event bus & deployment
- **EventBus overflow**: When buffer capacity is exceeded, the `event.bus.overflowed` event now includes `originalEventKind` and `originalStreamId` so consumers can determine what was lost.
- **Dockerfile**: Added missing `core-secrets` and `core-tenancy` manifest-layer COPY entries for correct workspace resolution during `npm ci`.


## Unreleased (v5-dev)

### Infrastructure wiring
- **core-secrets**: AWS Secrets Manager now implements SigV4 signing (previously was a non-functional stub). GCP Secret Manager now uses JWT-based service-account authentication with proper credentials file loading. Both providers are wired into the CLI bootstrap via `buildModelConfigAsync`.
- **core-telemetry**: OpenTelemetry SDK now initialized in CLI bootstrap when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. `--no-otel` flag disables. Proper shutdown on process exit.
- **SLO burn-rate reporting**: Now exposed in the `health` CLI command alongside existing health stats.

### Bug fixes
- **Empty-emission correction prompt**: When artifact or schema-contract modes produce zero files, the correction prompt now includes a clear message telling the worker to emit at least one file instead of returning a useless generic prompt.
- **validator-contract test semantic drift**: Test now imports the production `finalVerdictFromValidation` from truth-model.ts. Error/skipped validator status correctly maps to `"unknown"` instead of `"error"`.
- **walkFiles duplication eliminated**: Shared `walkFiles` utility extracted to `@55ndeep/core-logging` and used by both `tool-python` and `tool-secdev`. Consistent exclusion rules across both packages.
- **MemoryAdapter.persist() properly typed**: `persist()` added to the `MemoryAdapter` interface. Removed `(adapter as any).persist()` casts throughout the orchestrator.
- **gracefulShutdown order**: Event bus now drained before memory persists, preventing lost events on shutdown.
- **runCorrectionLoop catch block**: Internal exceptions now caught, logged, and translated to escalate outcomes with memory observations instead of throwing raw errors.
- **verifyWorkspace error handling**: `normalizeLanguage` wrapped in try/catch — unknown language returns an `err` result instead of throwing synchronously. Path safety rejections return an explicit error instead of silently dropping files.
- **buildCorrectionPrompt safe fallback**: Unknown languages fall back to generic tool names instead of throwing.
- **ClassifierMemory cross-run learning**: `loadFromStore()` now called at the start of each `runCorrectionLoop`, enabling the NLP classifier to learn from previous sessions.
- **CLI workspace path validation**: `--workspace` now validated with `existsSync` before registering a tenant handle.
- **TenantRegistry persistence**: Tenant registry now persists to `~/.55ndeep/tenants/index.json` across sessions.
- **Exclude filter depth**: cpSync filters in `_runIsolatedTurn` and `_createIsolatedWorkspace` now check all path segments for `node_modules`, `.git`, `dist`, `.tsbuildinfo`, not just the first.
- **Orchestrator concurrency guard**: `_busy` flag prevents concurrent `runCorrectionLoop` calls on a single instance with a clear error message.
- **Classifier confidence**: Formula now reduces confidence for single weak signals (`margin / max(1, highest) * min(1, highest / 20)` instead of plain `margin / max(1, highest)`).
- **Graphify cycle count**: DFS no longer returns early on cycle detection, correctly counting all cycles in multi-cycle components.
- **CI script gates**: Lint failure now exits with non-zero. Coverage threshold comparison uses Node.js instead of `bc` (portable across Alpine/Debian).
- **Test names corrected**: Agent-core "executes and returns emission on network failure" → "throws on network failure". Chaos test renamed with concurrency constraint documentation.

### Dependency changes
- `core-secrets`: No new dependencies (pure Node.js crypto for SigV4).
- `core-telemetry`: Now activated at runtime (OTel deps were already in `package.json`).

## 1.0.0 — 2026-05-13

### Framing

55NDeep is a **deterministic verification gate** that commoditizes model choice. Frontier thinks. Mid-tier works. Token cost per line of working code drops because the user isn't burning frontier tokens on what a mid-tier model + tool loop can handle. The system escalates to frontier only when the verifier gate says the cheap model genuinely can't fix the issue.

On Docker-validated tbench tasks: glm-5-1 and deepseek-v4-flash pass at 1,650–2,500 tokens/pass. Frontier-class glm-4-7 burns 5,000+.

### Core fixes

- **Race condition eliminated**: All emitters now `await eventBus.emit()`. Removed `setTimeout(200)` hacks from orchestrator and all test files
- **Python emitter false negatives**: `isMissingTool()` check prevents fabricated `errors: 1, critical: 1` when ruff/pyright/bandit aren't installed. Missing tools now emit `"skipped"` not `"error"`
- **Correction prompt language**: `toolNames(language)` in `correction-loop.ts` — Python tasks now reference ruff/pyright/bandit instead of eslint/tsc
- **Graphify advisory-only**: Non-TS files receive `"skipped"` status. Reducer respects this — no fabricated `brokenEdges: 1` for Python/Go/Shell
- **Correction loop taskId drift**: `baseId` / `let taskId` pattern replaces the bug where `const taskId` never updated across correction iterations

### New features

- **FileAdapter**: Persistent memory via JSON file. Replaces the dead `better-sqlite3` + `sqlite-vec` dependency plan
- **Language-aware contract templates**: `buildContractTemplate(language, hint)` generates language-specific contract prompts for all 10 supported languages
- **Graphify cycle detection**: DFS back-edge algorithm replaces the hardcoded `cycles: 0`
- **Secdev expansion**: +6 detection rules — GitLab PAT, Stripe live/test keys, Slack tokens, JWT strings, SQL injection via template literals

### Removed

- **ToolRunner** (118 lines): Never wired into the orchestrator. Unused abstraction removed from all packages, references, and tsconfig
- **`better-sqlite3`** runtime dependency: Replaced by FileAdapter
- **`sqlite-vec`** runtime dependency: Removed. Vector operations handled by FNV-1a hashing + cosine similarity (no DB needed)
- **`dotenv`** runtime dependency: Removed. Custom env parsing removed in v7 — config is explicit

### Documentation

- **5 ADRs** in `docs/adr/`: deterministic verification, event-driven reducer, language-aware contracts, memory routing engine, cheap worker thesis
- **`README.md`**: Architecture diagram, quick start, configuration, commands reference
- **`state.md`**: Package inventory, test coverage, known limitations, architecture invariants
- **`changelog.md`**: This file
- **Removed**: `conversation.md`, `BEGIN_HERE.md`, `REPORULES.md`, architecture review (`55_ndeep_cli_honest_architecture_review.md`), all legacy benchmark reports (`test_run*.md`, `SCAVENGE_REPORT.md`, `opencode-run-report*.md`)

### Tests

- 391 tests across 24 test files (23 packages).
- New test files for `model-client` (7), `agent-core` (2), `prompt-core` (5), `tool-secdev` (4), `memory-palace/FileAdapter` (2)
- All existing tests updated: `setTimeout` hacks removed from reducer tests, correction decision calls compatible with new `language` parameter

### Dependencies

Runtime dependencies: 11 packages (commander, zod, plus OTel SDK packages for telemetry). Total install: 420 packages.

---

## Pre-1.0.0

Prior development history exists in the sandbox at `/path/to/runtime-sandbox/bench/`. Key artifacts:

- `report-real-drift-5task-4worker.json` — 5-task × 4-worker drift comparison run
- `report-real-4model-3task.json` — 4-model × 3-task batch
- `report-real-glm-4task.json` — GLM-4.7 solo run with correction loop analysis
- `report-real-model-matrix-6worker.json` — 6-worker matrix
- Benchmark scripts: `real-tbench-benchmark.mjs`, `comprehensive-benchmark.mjs`, `head-to-head.mjs`, `honest-empirical.mjs`, `live-benchmark.mjs`, `sandbox-head-to-head.mjs`
