## v8.6 — Verifier fail-closed fix, broken-repo demo, stability matrix (2026-06-07)

### Bug fixes

- **Verifier fail-open defect**: `tool-tsc` and `tool-pyright` returned
  `Result.ok({ errors: 0 })` and emitted `status: "skipped"` when their
  underlying binary was missing (ENOENT). This made any environment
  without `tsc` or `pyright` installed pass type-checking on every task
  — directly contradicting the "deterministic verification" thesis. Now
  both emitters return `Result.err(...)` and emit `status: "error"` with
  a `VERIFIER_MISSING_BINARY` detail, so the reducer (and the overall
  verdict) correctly reports a failure. The "no target files" path
  (e.g. no `tsconfig.json`, no `*.py` files) still returns
  `status: "skipped"` because that is a legitimate skip — there is
  nothing to verify. The new contract is documented in
  `docs/STABILITY_MATRIX.md` and enforced by
  `packages/orchestrator/tests/verifier-fail-closed.test.ts` (6 cases).

- **pyright test isolation**: tests previously shared one `tmpDir` and
  could leak Python files between cases. Each test now uses an
  isolated per-case tmpDir.

- **CLI dist stale binary**: `apps/cli/dist/index.js` was a leftover
  ELF binary from a prior `pkg` build that broke the `cli+e2e` test
  batch. Re-built to a proper Node.js script.

- **Sandbox env-inherit doc**: `inheritParentEnv` doc comment now
  explicitly names the prompt-injection attack vector and the env vars
  it would expose (`OPENAI_API_KEY`, `KIRKFORGE_TENANT_KEY`, etc.).

### Additions

- **STABILITY_MATRIX.md**: per-package stability ratings
  (Stable/Beta/Experimental/Dev-only), 33 packages and 6 CLI commands
  rated. The verifier fail-closed contract is stated in the doc and
  enforced by tests.
- **DEPENDENCIES.md**: explains the bleeding-edge dev dep choices
  (typescript 6, eslint 10, vitest 4) and the production-only safety
  rails (`ALLOW_UNSAFE_HOST_SANDBOX`, `ALLOW_UNSAFE_VALIDATOR_SHELL`,
  `DOPAFLOW_ENTERPRISE_MODE` / `KIRKFORCE_ENTERPRISE_MODE`).
- **examples/verify-broken-repo/**: tiny fixture with three planted
  bugs (type error, eval-lint violation, broken import) plus a
  `verify-broken-repo.sh` driver. The driver runs
  `kirkforge verify` against the fixture and asserts the JSON packet
  reports `overall: "fail"`. This is the runnable counterpart to the
  stability matrix and the fail-closed contract.
- **verifier-fail-closed.test.ts**: 6 reducer-level cases for the
  skip/error/pass/fail combinations across policy.required and not.

### Test counts

- 970 → **997 tests** (+27: 1 new ENOENT case in `tool-tsc`,
  6 reducer-level fail-closed cases, plus unrelated additions in
  the broader suite during the build).
- 66 → **67 test suites** (+1: `verifier-fail-closed`).

## v8.5 — Docs cleanup, health server fix (2026-05-30)

### Documentation overhaul

- **README rewritten**: Leads with Brain/Brawn/Verifier thesis. Enterprise features moved to a section titled "Security and multi-tenancy" with a clear statement: "These are guardrails, not the product. The product is deterministic verification that makes cheap models productive."
- **Enterprise gap doc rewritten**: Replaced 2,800 words of compliance theater with an honest status checklist. No more "external audit" claims. Dark-Moon review credited correctly as AI-assisted review.
- **AGENTS.md rewritten**: Stripped the 40-item secure-defaults checklist. Replaced with actual project structure, key concepts, and dev commands.
- **summary.md deleted**: Was frozen at v5 with wrong numbers (525 tests, 29 packages). Actual: 970 tests, 66 suites, 34 packages.
- **Correct stats throughout**: 34 packages, 970 tests, 66 suites, ~22,500 lines production code, ~15,300 lines test code.

### Bug fixes

- **Health server**: Fixed 3 test failures where PUT/DELETE/POST and unknown paths returned 500 instead of 405/404. The async request handler wasn't wrapped in try/catch, so unhandled rejections fell through to Node's default 500 response. Moved all request handling inside the try/catch block.

### Repo hygiene

- Removed revoked PAT references from REPORULES.md (7 repos)
- Switched all git remotes from HTTPS+PAT to SSH
- Purged credential store — using cache-only with 1hr timeout
- Deleted stale dependabot branches (6 branches across 2 repos)
- Pruned stale remote-tracking refs across all 20 repos
- Fixed ci-cleandev to honor `.trufflehog_exclude` per-project
- Fixed README titles to match GitHub repo names (6 repos)
- Renamed local folders to match GitHub repo names (3 repos)
- Updated all cross-references in REPORULES.md to use consistent folder names

## v8.4 — Native strict lint, all 3 phases complete (2026-05-20)

### Phase 3 completion — 8 languages, native lint

- **8 lint packages**: `tool-lint-core` (shared engine), `tool-lint-ts` (29 rules), `tool-lint-py` (34 rules), `tool-lint-sh` (9 rules), `tool-lint-c` (10 rules), `tool-lint-rs` (8 rules), `tool-lint-go` (7 rules), `tool-lint-sql` (6 rules) — **~103 total rules** across all languages
- **Full test coverage**: 30 tests across 8 lint packages (C: 8, Rust: 7, Go: 7, SQL: 8, plus existing TS/Py/Sh). All rules have detection + clean-pass + file-filter tests.
- **emitter-factory routing**: All 8 languages routed through native `create*LintEngine()` factories based on task profile language. Per-language lint engine dispatch.
- **Deprecated wrappers**: ESLint (tool-eslint), Ruff/Bandit (tool-python lint methods). Type checking (tsc), git (gitnexus), and graph (graphify) preserved.
- **Benchmark**: ~138ms/100 files, 100% finding parity vs Ruff's ~90ms

### Build & test

- `tsc --build`: **clean** | `npm test`: **508 tests, 35 files, 0 failures**
- CLI smoke tests fixed (`tsc --build --force` regenerates `apps/cli/dist/`)
- All 28 packages build and import cleanly

---

## Unreleased (v7-dev)

### Task decomposition & execution engine

- **decompose CLI command**: Breaks complex tasks into smaller, independently verifiable subtasks using a dedicated planning model. Returns a topologically sorted dependency tree with complexity estimates and token projections.
- **executeDecomposition**: New orchestrator method walks the sorted task tree, delegates each subtask in dependency order, propagates dependency failures (children of failed deps are skipped with clear error messages), and returns a structured `DecompositionExecutionResult` with per-node `SubtaskExecutionResult` entries.
- **`--execute` flag on decompose**: Chains decompose → execute in one command. Prints a compact summary with ✓/✗ status, tokens, duration, and output files per subtask. JSON mode serializes the full result.
- **`recall-decomposition` CLI**: Recalls previously stored decompositions from memory for inspection or re-execution.
- **DECOMPOSE_TEMPLATE**: Zod-validated prompt template (`@kirkforge/prompt-core`) with schema-contract response shaping. Validates `id`, `description`, `language`, `dependsOn`, `estimatedComplexity` (enum), `outputFiles`, and `verificationHint` at both template and parse time.
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

- **Bootstrap no longer auto-loads `.env`/`.kirkforcerc`**: Config loading is explicit. No implicit process.cwd file reads at import time. Removes a source of non-deterministic behavior.
- **ConfigService.load() no longer mutates `process.env`**: The `KIRKFORGE_CONFIG` key is no longer written to the global environment. Callers manage their own config path tracking.
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
- **HealthServer export**: Added `./health-server` export to `@kirkforge/orchestrator` package.json exports map.
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
- **walkFiles duplication eliminated**: Shared `walkFiles` utility extracted to `@kirkforge/core-logging` and used by both `tool-python` and `tool-secdev`. Consistent exclusion rules across both packages.
- **MemoryAdapter.persist() properly typed**: `persist()` added to the `MemoryAdapter` interface. Removed `(adapter as any).persist()` casts throughout the orchestrator.
- **gracefulShutdown order**: Event bus now drained before memory persists, preventing lost events on shutdown.
- **runCorrectionLoop catch block**: Internal exceptions now caught, logged, and translated to escalate outcomes with memory observations instead of throwing raw errors.
- **verifyWorkspace error handling**: `normalizeLanguage` wrapped in try/catch — unknown language returns an `err` result instead of throwing synchronously. Path safety rejections return an explicit error instead of silently dropping files.
- **buildCorrectionPrompt safe fallback**: Unknown languages fall back to generic tool names instead of throwing.
- **ClassifierMemory cross-run learning**: `loadFromStore()` now called at the start of each `runCorrectionLoop`, enabling the NLP classifier to learn from previous sessions.
- **CLI workspace path validation**: `--workspace` now validated with `existsSync` before registering a tenant handle.
- **TenantRegistry persistence**: Tenant registry now persists to `~/.kirkforge/tenants/index.json` across sessions.
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

KirkForge is a **deterministic verification gate** that commoditizes model choice. Frontier thinks. Mid-tier works. Token cost per line of working code drops because the user isn't burning frontier tokens on what a mid-tier model + tool loop can handle. The system escalates to frontier only when the verifier gate says the cheap model genuinely can't fix the issue.

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
- **Removed**: `conversation.md`, `BEGIN_HERE.md`, `REPORULES.md`, architecture review (`kirkforge_cli_honest_architecture_review.md`), all legacy benchmark reports (`test_run*.md`, `SCAVENGE_REPORT.md`, `opencode-run-report*.md`)

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

### Phase 3: Native strict lint for all 8 supported languages (2026-05-20)

- **`@kirkforge/tool-lint-sh`**: 9 inline rules detecting unquoted variables, curl-bash-pipe, rm -rf \*, sudo, eval, and more. File-level shebang check via shared engine.
- **`@kirkforge/tool-lint-c`**: 10 rules covering safety (no-gets, no-strcpy, no-sprintf, no-system), style (no-malloc-cast, no-ternary-nest, no-goto, no-magic-numbers), and correctness (no-void-main, no-missing-include-guard). Supports .c/.cc/.cpp/.cxx/.h/.hpp/.hxx extensions.
- **`@kirkforge/tool-lint-rs`**: 8 rules for safety (no-unwrap, no-unsafe, no-expect-in-prod), performance (no-clone-on-copy), maintainability (no-todo, no-dbg), and style (no-println-in-lib).
- **`@kirkforge/tool-lint-go`**: 7 rules for safety (no-panic), correctness (no-unhandled-error), style (no-global-var, no-naked-return), performance (no-defer-in-loop), and maintainability (no-init-side-effect, no-string-title).
- **`@kirkforge/tool-lint-sql`**: 6 rules for safety (no-drop-table, no-truncate, no-unsafe-delete, no-dynamic-injection), performance (no-select-star), and correctness (no-implicit-join).
- **Full test coverage**: 30 tests across all 8 lint packages. Tests verify rule detection, clean-pass cases, and file-filter scoping.
- **All 3 phases complete**: `emitter-factory.ts` routes all 8 languages through native `@kirkforge/tool-lint-*` engines. Deprecated: ESLint (tool-eslint), Ruff/Bandit (tool-python lint). Kept: tsc, gitnexus, graphify.
- **Benchmark vs Ruff**: 100% finding parity (24/24), ~138ms/100 files vs Ruff's ~90ms.
