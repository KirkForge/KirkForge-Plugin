# 55NDeep — State Snapshot

## 2026-05-20 (v8.4, all 3 lint phases complete + decompose/execute engine)

### Build & Test

- `tsc --build`: **clean** (0 errors)
- ESLint: **clean** (0 errors, 0 warnings, --max-warnings 0)
- `tsc --noEmit`: **clean**
- Test suites: **36 passed, 525 tests pass** (all 8 lint packages tested, CLI smoke tests fixed) (6 sqlite-adapter tests conditionally skipped when better-sqlite3 native bindings unavailable). All suites pass: orchestrator 77, coverage 67, chaos 6, validator-contract 12, memory 19, events 4, correction-core 48 + boundary 5 + task-validator 7 + bench-normalize 17 = 77, model-client 7, model-config 6, core-logging 6, core-secrets 13, core-tenancy 13, core-telemetry 5, agent-core 2, secdev 4, prompt-core 5, result 10, fuzz 29, plugin 29, cli 22, doctor 6.
- Full `npm test`: ~60s, 36 suites, no hangs.
- 29 packages, all importable at runtime

### Paths

- Repo: `55NDeep-plugin`
- Published: `https://github.com/KirkForge/55NDeep-plugin`
- Bug audit: included in repo history

---

## v8 — Transactional memory, protocol hardening, deployment hygiene

### Memory correctness

- **SqliteAdapter**: `writeRunAndEmissions()` with `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` — run + emissions are atomic for SQLite-backed stores.
- **FileAdapter**: Cross-process lock added around `flush()`. Note: concurrent processes that both load stale in-memory state before flushing can still lose each other's writes (read-modify-write across processes is not fully atomic). Sufficient for single-process daemon use; concurrent CLI automation should use SqliteAdapter.

### Protocol tightening

- **JSONL base64**: Validated against canonical regex before decoding.
- **JSONL unknown types**: Unrecognized `type` fields trigger `strictTermination = false`.
- **JSONL non-JSONL chatter**: Non-empty lines that don't start with `{` now break strict mode.
- **JSONL empty / no-protocol output**: Non-empty output with no JSONL lines returns `strictTermination: false`. Truly empty output is caught downstream by the orchestrator's empty-emission override (produces a useful correction prompt).
- **writeArtifacts()**: Policy checks (overwrite, denyPaths) run before reading `beforeHash`. Read failures produce structured blocked results.

### Profile & config accuracy

- **Shell profile**: `checkCommand` corrected to `"bash -n"` (matches `structuredCheck`; ShellCheck is not part of the built-in check).
- **Vault KV v2**: Path segments encoded individually, preserving `/` separators.
- **ConfigService.getPath()**: Uses `relative()` for cross-platform workspace containment.
- **ModelClient circuit breaker**: Disambiguates same-type providers (OpenAI vs OpenRouter vs Ollama) by including baseUrl host.

### Deployment

- **Dockerfile**: Added `core-secrets` and `core-tenancy` manifest COPY entries. CMD is `serve` — container runs as daemon.
- **docker-compose**: `command: ["serve"]` — container stays alive.
- **Helm**: `configmap.yaml` added; `deployment.yaml` checksum annotation resolves correctly.
- **`serve` command**: CLI daemon starts `HealthServer` on port 9090, blocks until SIGTERM. Endpoints: `/healthz`, `/readyz`, `/metrics` (JSON format).
- **EventBus overflow**: Now includes `originalEventKind` and `originalStreamId`.

---

## v8.3 — Task decomposition, execution engine, enterprise hardening (2026-05-20)

### Decomposition & execution

- **`decompose` CLI**: Breaks complex tasks into dependency-ordered subtrees using a dedicated planning model. Outputs topologically sorted nodes with complexity estimates and token projections.
- **`--execute` flag**: Chains decompose → execute in one command. Prints per-subtask ✓/✗ status, tokens, duration, and output files.
- **`recall-decomposition` CLI**: Recalls stored decompositions for inspection.
- **`executeDecomposition`**: Walks the sorted tree, delegates each subtask, propagates dependency failures, returns structured per-node results.
- **Subtask retry**: One automatic retry on first delegate failure.
- **Per-subtask timeout**: 5-minute hard limit via `Promise.race`.

### Enterprise hardening

- **Defensive topological re-sort**: Execution engine re-sorts stored tasks, catching corrupted or hand-edited memory stores. Cycle detection surfaces invalid dependency graphs.
- **Zod validation at parse time**: `_parseDecomposition` validates against `DECOMPOSE_TEMPLATE.responseSchema` (same schema the model sees). Manual coercion fallback for rough model output.
- **Safe packet access**: Replaced `result.value.packet!` with optional chaining — no non-null assertions in delegate result handling.
- **Bracket heuristic**: Handles prose brackets, markdown fences, nested markers in strings, bracket-like paths, and whitespace-heavy output. 6 fuzz tests cover edge cases.
- **Dead `--execute` flags removed**: Stripped from `delegate`, `run`, `verify`, `recall-decomposition` — only `decompose --execute` implements the feature.
- **MockOrchestrator sync**: Test mock matches real implementation (self-dependency check, max-24 guard, Zod validation path, defensive re-sort tests).

## v5–v7 — Infrastructure wiring & 25+ bug fixes

### Infrastructure now wired

- **Secrets** — Chained: Vault → AWS (SigV4-signed, pure Node.js crypto) → GCP (JWT) → env. API keys resolved through secrets chain before model config is built.
- **Telemetry** — OpenTelemetry SDK activates when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Traces/metrics exported via OTLP.
- **SLO** — Burn-rate report surfaced in `health` CLI command and `/metrics` endpoint.

### Major bug fixes

- Empty-emission produces actionable correction prompt
- validator-contract tests use production truth-model (error → unknown)
- walkFiles deduplicated into shared `@55ndeep/core-logging`
- `MemoryAdapter.persist()` properly typed (non-optional `Promise<void>`)
- `gracefulShutdown` order: event bus drains before memory persists
- `verifyWorkspace` returns `err` on unknown language (no sync throws)
- `buildCorrectionPrompt` falls back safely on unknown language
- `ClassifierMemory.loadFromStore` wired for cross-run NLP learning
- CLI `--workspace` path validated before tenant registration
- `TenantRegistry` persists tenants to `~/.55ndeep/tenants/index.json`
- cpSync exclude filters check all path segments
- Orchestrator `_busy` flag prevents concurrent `runCorrectionLoop`
- Classifier confidence formula dampens single weak signals
- Graphify DFS counts all cycles in multi-cycle components
- Hard-prompt `beforeHash`/`existed` snapshotted before atomic write
- Hard-prompt `files.written` feeds same emission ledger as `artifact.emitted`
- CI script: lint failure exits non-zero; coverage uses Node.js not `bc`

---

## Key Design Decisions

- **`Result<T,E>` everywhere** — No throws at async boundaries
- **Fail-closed** — Missing verifier → fail; missing required validator → fail
- **Single truth model** — `computeFinalVerdict()` with documented 8-level precedence
- **Memory** — FileAdapter default (zero native deps); SQLite opt-in via `sqlitePath`
- **Secrets** — Chained: Vault → AWS (SigV4) → GCP (JWT) → env
- **SLO** — Google SRE workbook multi-window burn-rate alerting
- **Tenant isolation** — Fresh workspace per turn, scoped storage, persistent registry
- **Non-root** — Docker uid 1000

---

## Deployment

| Method         | Command                                                        |
| -------------- | -------------------------------------------------------------- |
| Docker         | `docker build -t 55ndeep . && docker run -p 9090:9090 55ndeep` |
| Docker Compose | `docker-compose up -d`                                         |
| Kubernetes     | `helm install 55ndeep ./deploy/helm/55ndeep`                   |

## Health

- CLI: `55ndeep health` — status, event bus stats, memory, SLO burn-rate report
- Daemon: `GET /healthz` · `GET /readyz` · `GET /metrics` (JSON stats; for Prometheus use the OTel OTLP pipeline)
- Auth: `Authorization: Bearer <HEALTH_API_KEY>`

---

## Known Issues (v8.2 — resolved)

All bugs from the v8 consolidation audit are now fixed. Bug consolidation details are tracked in the repository changelog.

**Remaining hardening notes (non-blocking, future work):**

- Validator baseline copies the working directory via `_ensureBaselineSnapshot()`. Clean external snapshot + emission overlay would be architecturally ideal.
- FileAdapter remains best-effort single-process — use SqliteAdapter for multi-process durability.
- `/metrics` endpoint returns JSON (not Prometheus scrape format) — documented; use OTel OTLP pipeline for Prometheus.
- `evictFromIndex()` removes from tenant index but does not delete on-disk storage (safety choice).
- 36 test suites, 525 tests. Full `npm test` takes ~57s.

---

## Stats

## Stats

- Packages: 29 (24 core + 1 app)
- Test files: 36
- Runtime dependencies: 11 packages
- Total install: ~420 packages
- Production code: ~8,500 lines
- Test code: ~5,500 lines
