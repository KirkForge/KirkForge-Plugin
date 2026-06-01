# Benchmark Evidence Index

This directory contains sanitized benchmark result summaries. Raw JSON reports and logs live in `/tmp/bench-sandbox/` or the sandbox `bench/` directory, never in the publish repo.

## How to read these reports

**No model-comparison claims should be made from `missing-validator` runs.** When `taskValidation.status` is `"skipped"`, the task outcome is unknown — not failed. `taskPass` is `null` in these cells, not `false`.

## Report inventory

| Report                                                                                                       | Date       | Label                                           | Task validators                                 | Notes                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [post-pr41-truth-model-run.md](post-pr41-truth-model-run.md)                                                 | 2026-05-14 | **infra audit**                                 | ❌ missing (`gpt-oss:cloud` endpoint failure)   | Used wrong model name `gpt-oss:cloud`. GPT-OSS row is invalid endpoint/model-name failure, not quality evidence.                                                                                                                                                 |
| [2026-05-14-rnj-vs-gpt-oss-120b.md](2026-05-14-rnj-vs-gpt-oss-120b.md)                                       | 2026-05-14 | **task-validator-only**                         | ⚠️ pre-PR42 (no ruff/pyright/bandit)            | Corrected GPT-OSS rerun with `gpt-oss:120b-cloud`. Python verifiers were missing. `taskPass: true` rows are TBench task-validator evidence only, not full verifier-loop evidence.                                                                                |
| [2026-05-14-post-pr42-full-verifier-rerun.md](2026-05-14-post-pr42-full-verifier-rerun.md)                   | 2026-05-14 | **infra audit**                                 | ❌ missing (`taskValidation.status: "skipped"`) | Post-PR42 rerun with ruff/pyright/bandit installed. All 24 cells have `missing-validator`. TBench task validators not available. 0/24 pass is infra, not model quality.                                                                                          |
| [2026-05-14-post-plugin-rename-validator-benchmark.md](2026-05-14-post-plugin-rename-validator-benchmark.md) | 2026-05-14 | **infra audit**                                 | ❌ missing (`taskValidation.status: "skipped"`) | Post-PR50 rename. 4 tasks × 4 workers. All 16 cells `missing-validator`. Verifier preflight passed. 0/16 pass is infra, not model quality.                                                                                                                       |
| [2026-05-14-validator-capable-task-inventory.md](2026-05-14-validator-capable-task-inventory.md)             | 2026-05-14 | **validator inventory**                         | N/A                                             | Scans for Docker validator trio. No tasks on current host have `docker-compose.yaml` + `run-tests.sh` + `tests/`.                                                                                                                                                |
| [2026-05-15-archived-tbench-worker-discovery.md](2026-05-15-archived-tbench-worker-discovery.md)             | 2026-05-15 | **archived TBench post-hoc validator evidence** | ✅ archived TBench validators                   | 20 tasks × 4 workers from `/path/to/research/KirkForge/Testsuite_tasks`. Produces real `taskValidation.status` and `taskPass`, but the runner still validates post-hoc rather than through native `run --validator`, so `finalVerdict`/`sourceOfTruth` are absent. |
| [2026-05-15-native-validator-smoke.md](2026-05-15-native-validator-smoke.md)                                 | 2026-05-15 | **native validator smoke**                      | ✅ native `run --validator`                     | Small 3-task × 2-worker proof that `finalVerdict` and `sourceOfTruth: "task-validator"` are populated inside the runtime.                                                                                                                                        |
| [2026-05-15-225-rnj-native-long-run.md](2026-05-15-225-rnj-native-long-run.md)                               | 2026-05-15 | **native single-worker drift check**            | ✅ native `run --validator`                     | `.225` RNJ-only long run. RNJ passed 1/18. This is real negative evidence and a routing-memory signal, not a missing-validator artifact.                                                                                                                         |

## Key definitions

- **task-validator-only**: Task validators (Docker TBench) ran, but local verifier-loop tools (ruff/pyright/bandit) were missing. `taskPass` reflects TBench results only.
- **full-verifier rerun**: Both local verifiers and task validators ran. This is the target evidence type.
- **infra audit**: Task validators were unavailable (`missing-validator` or `docker-unavailable`). All `taskPass` values are `null`. No model-quality claims possible.
- **validator inventory**: A scan of available task infrastructure, not a model run.
- **archived TBench post-hoc validator evidence**: Real archived TBench validators ran and produced task pass/fail signal, but the benchmark runner did not yet use the native runtime `--validator` hook.

## What blocks model-quality evidence

To produce model-comparison evidence, a benchmark run needs:

1. **TBench task validators** — `docker-compose.yaml` + `run-tests.sh` + `tests/` per task
2. **Local verifier tools** — ruff, pyright, bandit in PATH (checked by `verifierPreflight`)
3. **Workers with valid endpoints** — no `cloud_timeout_or_empty` or `endpoint_or_model_name_fail`

When any of these is missing, the run is an infrastructure audit, not a model comparison.

## Importing worker reports

Worker benchmark reports from remote machines (e.g. .225) should be imported as markdown summaries only. Use `scripts/import-worker-bench-report.sh`:

```bash
# From the publish repo
./scripts/import-worker-bench-report.sh /path/to/worker/report.md
./scripts/import-worker-bench-report.sh --force /path/to/worker/report.md  # overwrite
```

The import script refuses `.json`, `.log`, `.tmp`, and `.env` files. Only `.md` files enter the publish repo. This prevents raw benchmark data from leaking into version control.

## v1 release candidate status

This is v1.0.0-rc1. The plugin contract, verifier preflight, and native validator hook are implemented. Native `run --validator` reports now exist and include `finalVerdict`, `sourceOfTruth`, `taskValidation`, and tri-state `taskPass`.

The remaining final-v1 evidence gap is not "can native validation run"; that is proven. The gap is broader model-quality evidence: rerun the same native-validator task panel across several workers and classify failures by task family, artifact shape, validator status, and cloud reliability.
