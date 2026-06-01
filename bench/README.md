# KirkForge Plugin — TBench Benchmark

## Repository Roles

There are two copies of this project:

| Repo             | Path                       | Role                                |
| ---------------- | -------------------------- | ----------------------------------- |
| **Publish repo** | `/path/to/publish-repo`    | Clean source, docs, tracked scripts |
| **Sandbox**      | `/path/to/runtime-sandbox` | Active benchmark/runtime copy       |

Do **not** run `npm ci`, `npm install`, benchmarks, or Docker commands from the publish repo. Use the sandbox for all runtime work.

See `REPORULES.md` for full rules.

## Setup

- The sandbox has cloud provider configuration (OpenRouter free tier, NVIDIA NIM)
- No local Ollama required — all API calls go to cloud endpoints
- Mid-tier worker model: `gemma-3-4b-it:free` (OpenRouter)

## How to Run

From the sandbox:

```bash
cd /path/to/runtime-sandbox
TBENCH_DIR=/path/to/Testsuite_tasks node bench/real-tbench-benchmark.mjs
```

For Docker validators:

```bash
sg docker -c 'TBENCH_DIR=/path/to/Testsuite_tasks VALIDATOR_BACKEND=docker node bench/real-tbench-benchmark.mjs'
```

See `REAL_TBENCH_GUIDE.md` for full configuration options.

## What It Measures

| Metric        | KirkForge                        | OpenCode                   |
| ------------- | -------------------------------- | -------------------------- |
| Worker tokens | Correction loop total            | Single shot                |
| Corrections   | Up to 3 retries                  | 0                          |
| Verification  | eslint + tsc + secdev + graphify | None                       |
| Files written | Persisted from artifact mode     | Persisted from hard-prompt |

## Output

- Per-task token counts, pass rates, correction counts
- Aggregate delta (tokens, passes, escalations)
- JSON report at `/tmp/bench-sandbox/report-real-<timestamp>.json`
- Sanitized markdown summaries in `bench/results/`

## Syncing Changes

After editing source in the publish repo, push to sandbox:

```bash
# Preview what will be copied
./scripts/sync-to-sandbox.sh --dry-run

# Actually sync
./scripts/sync-to-sandbox.sh
```

## Checking Publish Repo Cleanliness

```bash
./scripts/check-clean-publish-repo.sh
```

This flags raw JSON, logs, `.env`, or other runtime artifacts that should not be in the publish repo.
