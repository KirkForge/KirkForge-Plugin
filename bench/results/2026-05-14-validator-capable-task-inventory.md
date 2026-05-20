# Validator-Capable Task Inventory

**Date**: 2026-05-14
**PR**: 52

## Scan Results

The benchmark runner (`bench/real-tbench-benchmark.mjs`) requires tasks to have a **validator trio** to produce meaningful `taskPass` results:

1. `docker-compose.yaml`
2. `run-tests.sh`
3. `tests/` directory

The `TBENCH_DIR` environment variable must point to a directory containing task subdirectories. The current environment has **no TBENCH_DIR populated with validator-capable tasks**.

### Scanning for validator files

No task directories were found on this host containing any of the validator entry points (`docker-compose.yaml`, `run-tests.sh`, `tests/`).

The four tasks used in the previous run (csv-to-parquet, broken-python, simple-web-scraper, form-filling) all returned `taskValidation.status: "skipped"` with `validator: "missing-validator"` because none had the Docker validator trio.

### Task inventory from DEFAULT_TASKS list

| Task | docker-compose.yaml | run-tests.sh | tests/ | Language | Suitable for v1 evidence? |
|------|--------------------|--------------|-------|----------|--------------------------|
| accelerate-maximal-square | ❌ not found | ❌ not found | ❌ not found | unknown | ❌ No — no validator |
| create-bucket | ❌ not found | ❌ not found | ❌ not found | unknown | ❌ No — no validator |
| broken-python | ❌ not found | ❌ not found | ❌ not found | Python | ❌ No — no validator |
| debug-long-program | ❌ not found | ❌ not found | ❌ not found | unknown | ❌ No — no validator |
| csv-to-parquet | ❌ not found | ❌ not found | ❌ not found | unknown | ❌ No — no validator |
| simple-web-scraper | ❌ not found | ❌ not found | ❌ not found | unknown | ❌ No — no validator |
| form-filling | ❌ not found | ❌ not found | ❌ not found | unknown | ❌ No — no validator |

(All 20 default tasks share the same status — no validator files on this host.)

## Assessment

**No validator-capable tasks are available in the current environment.** The TBench task directory must be populated with tasks that include `docker-compose.yaml`, `run-tests.sh`, and `tests/` directories before the benchmark can produce `taskPass: true` results.

The benchmark runner supports two validator backends:
- **`docker`** — requires `docker-compose.yaml` + `run-tests.sh` + `tests/` (Docker TBench)
- **`local`** — requires `tests/` directory (local pytest runner)

Neither backend has task infrastructure in place.

## Recommendation

Before running more model-comparison benchmarks:

1. **Populate `TBENCH_DIR`** with tasks that have Docker validator trios or local `tests/` directories.
2. **Verify one task end-to-end** with `VALIDATOR_BACKEND=docker` or `VALIDATOR_BACKEND=local` before running a full matrix.
3. **Do not interpret `missing-validator` results as model-quality evidence.** A skipped validator means the task outcome is unknown, not that the model failed.

## Benchmark runner fix applied

The `taskPass` field in benchmark reports now uses tri-state semantics aligned with the CLI:

- `taskValidation.status === "pass"` → `taskPass: true`
- `taskValidation.status === "fail"` → `taskPass: false`
- `taskValidation.status === "skipped"` or `"error"` → `taskPass: null`

Previously, `taskPass` was `false` for skipped/error validations. This change means `missing-validator` cells now correctly show `taskPass: null` instead of `taskPass: false`, making it clear that the task outcome is unknown rather than failed.
