# Real TBench Benchmark Guide

This guide is for an external runner, for example OpenCode, working in:

```text
/path/to/runtime-sandbox
```

The clean publish repo is:

```text
/path/to/publish-repo
```

Do not run dependency installs or benchmark work from the clean repo. The sandbox is the active working copy and has `node_modules`, `.env`, Docker access, and local benchmark state.

## Repository Roles

| Repo         | Path                       | Role                                |
| ------------ | -------------------------- | ----------------------------------- |
| Publish repo | `/path/to/publish-repo`    | Clean source, docs, tracked scripts |
| Sandbox      | `/path/to/runtime-sandbox` | Active benchmark/runtime copy       |

- Source of truth: the **publish repo**.
- Raw benchmark JSON and logs live in `/tmp/bench-sandbox/` or the sandbox `bench/` directory, never in the publish repo.
- Sanitized markdown summaries (`bench/results/*.md`) may be copied back to the publish repo.
- Use `scripts/sync-to-sandbox.sh` to push tracked files from publish repo to sandbox.
- Use `scripts/check-clean-publish-repo.sh` to verify no runtime artifacts are in the publish repo.
- See `REPORULES.md` for full rules.

## Goal

Measure real task success, not harness optimism.

Primary metric:

```text
taskOutcome === "pass"
```

The `taskOutcome` field is derived from `taskValidation.status` via `taskOutcomeFromValidation()` (from `@55ndeep/correction-core`). It is distinct from `verifierOverall` (from `ReducedStatePacket.verification.overall`) and from `finalAction` (the harness's accept/escalate decision). The `taskPass` compatibility field is `taskValidation.status === "pass"`, not `finalAction === "accept"` or `verifierOverall === "pass"`.

Each benchmark result now includes:

- `verifierOverall`: the orchestrator's overall verdict (`pass`, `warn`, `fail`, `unknown`, or `none` for solo runs)
- `taskValidation`: `{ status, validator, reason?, details? }` from `normalizeTaskValidation()`
- `taskOutcome`: `"pass"`, `"fail"`, or `"escalate"` mapped from `taskValidation.status`
- `taskPass`: boolean compatibility field (`true` only when `taskValidation.status === "pass"`)

Secondary metrics:

```text
tokens
summary.accounting.workerTokensPerTaskPass
summary.accounting.totalTokensPerTaskPass
summary.oversight.tokens
summary.oversight.minutes
durationMs
filesCreated
finalAction
validation.kind
validation.output
```

Important: `finalAction: "accept"` is not task success. It only means the harness accepted its verifier packet. A run counts as success only when the task validator passes.

`tokens` is worker/correction-loop spend only. If a human/Codex/OpenCode babysitter had to supervise, rewrite commands, change the guide, restart failed runs, or decide the next matrix, record that separately with `OVERSIGHT_TOKENS` and `OVERSIGHT_MINUTES`. The honest cost metric is:

```text
summary.accounting.totalTokensPerTaskPass
```

That is `workerTokens + oversightTokens` divided by real task passes. This is the metric for "how many tokens did the whole supervised system need to make the scoped run pass."

## Current Harness Fixes

The sandbox now includes these drift-prevention fixes:

- artifact writer strips one outer markdown fence from `### FILE:` content before writing files
- artifact prompt explicitly forbids markdown fences and surrounding prose
- hard-prompt system prompt no longer uses senior/skilled-developer persona language
- verifier emitters are selected from `detectTaskProfile(task.description).language`, not emitted file extension

The verifier routing change matters. If a Python task drifts into a `.ts` filename, it should still get Python-oriented verifier routing. File extension is only fallback for direct/legacy calls.

## Current Kernel

The useful claim being tested:

```text
small/cheap model emits files
local deterministic tools inspect state
reducer compresses failures
correction loop retries with targeted feedback
real task tests decide success
```

This is not a persona-memory or markdown-prompt test. Memory, when used, should mean empirical routing memory: task fingerprint, model, verifier outcome, test outcome, tokens, latency, and future route bias.

## Runner

Use:

```bash
TBENCH_DIR=/path/to/Testsuite_tasks node bench/real-tbench-benchmark.mjs
```

Full path:

```text
/path/to/runtime-sandbox/bench/real-tbench-benchmark.mjs
```

Reports are written to:

```text
/tmp/bench-sandbox/report-real-*.json
```

The harness tasks are read from the `TBENCH_DIR` environment variable:

```bash
TBENCH_DIR=/path/to/Testsuite_tasks node bench/real-tbench-benchmark.mjs
```

`TBENCH_DIR` must point to the TBench task directory containing task folders. If not set, the script will exit with an error.

## Verifier Preflight

Before running any model calls, the benchmark checks that required verifier tools are available for the task languages in the selected task set.

### Python verifier requirements

When Python tasks are included (the common case for TBench), the benchmark requires:

- **ruff** — lint checks (required)
- **pyright** — type checks (required)
- **bandit** — security checks (advisory, not blocking)

If `ruff` or `pyright` are missing from `PATH`, the benchmark exits before spending any model tokens:

```text
Missing required Python verifier tools for benchmark:
- ruff: not found
- pyright: not found

Install:
  python3 -m pip install --user ruff bandit
  npm install -g pyright
  export PATH="$HOME/.local/bin:$PATH"

Or set:
  ALLOW_MISSING_VERIFIERS=1

to run anyway, but results must be treated as task-validator-only, not full verifier-loop evidence.
```

### Why this matters

The 55NDeep harness runs a verifier loop: emit files → local verifiers (ruff, pyright, bandit) → reducer → correction loop. When required verifiers are missing:

- The reducer cannot perform lint or type checks, so it fails closed.
- `finalAction: "escalate"` and `cliAccepts: 0` are expected even when `taskPass: true`.
- Results reflect only the TBench task validator (Docker-based tests), not the full verifier-loop evidence chain.

A result that passes TBench validation but was produced without ruff/pyright cannot claim full verifier-loop coverage. Such results are `task-validator-only`.

### Running without verifiers

To run the benchmark when required verifiers are unavailable (e.g., CI environments, quick smoke tests):

```bash
ALLOW_MISSING_VERIFIERS=1 TBENCH_DIR=... node bench/real-tbench-benchmark.mjs
```

This prints a warning but does not exit. The report JSON will include:

```json
{
  "verifierPreflight": {
    "status": "warn",
    "missingRequired": ["ruff", "pyright"],
    "missingAdvisory": ["bandit"],
    "note": "Missing required verifiers; results are task-validator-only, not full verifier-loop evidence."
  }
}
```

When all required tools are present, the report includes:

```json
{
  "verifierPreflight": {
    "status": "pass",
    "missingRequired": [],
    "missingAdvisory": ["bandit"]
  }
}
```

### Install commands

```bash
# Required
python3 -m pip install --user ruff
npm install -g pyright
export PATH="$HOME/.local/bin:$PATH"

# Advisory (optional, not blocking)
python3 -m pip install --user bandit
```

## Environment

Run from the sandbox:

```bash
cd /path/to/runtime-sandbox
```

Docker is installed. In this shell, use `sg docker -c '...'` unless plain Docker works:

```bash
docker ps
```

If that fails with permissions, run benchmark commands as:

```bash
sg docker -c 'VALIDATOR_BACKEND=docker ... node bench/real-tbench-benchmark.mjs'
```

Ollama Cloud is accessed through localhost-compatible API settings in the sandbox `.env`. These are cloud model calls, not local GPU runs. They can be slower than normal API calls and can return timeouts or empty responses when cloud capacity is overloaded.

## Runner Flags

The script is controlled by environment variables:

```text
TBENCH_DIR        required: path to the TBench task directory (e.g. Testsuite_tasks)
TASKS             comma-separated task names
TASK_LIMIT        first N tasks from the default task list
WORKERS           comma-separated Ollama model names
INCLUDE_SOLO      0 disables solo baseline
MAX_CORRECTIONS   correction turns per 55NDeep worker, default 2
RUN_VALIDATORS    0 skips real validators, not recommended for final evidence
VALIDATOR_BACKEND docker | local | auto
BENCH_VALIDATOR_MODE posthoc (default) | native
KEEP_RUNS         1 preserves temp run dirs for inspection
OVERSIGHT_TOKENS estimated babysitter/orchestrator tokens spent to get this scoped run launched/interpreted
OVERSIGHT_MINUTES babysitter/orchestrator wall time for this scoped run
OVERSIGHT_ACTOR  who provided oversight, for example codex, opencode, human
OVERSIGHT_NOTES  short plain-text note about what the oversight covered
ALLOW_MISSING_VERIFIERS  1 skips the verifier preflight check and runs anyway; results are task-validator-only
```

### Preflight Checks

Before the run starts, the benchmark script validates the configuration:

- **TBENCH_DIR** must be set, exist, and contain at least one task directory.
- **Node ≥ 22** is required when `BENCH_VALIDATOR_MODE=native`.
- **BENCH_VALIDATOR_MODE=native** requires `RUN_VALIDATORS=1`. Setting native mode without validators enabled is a configuration error and will exit immediately.
- **VALIDATOR_BACKEND=docker** requires Docker to be available. With `auto`, Docker unavailability falls back to local validation.

A one-line preflight summary is printed before the first task:

```text
[real-bench] mode=native backend=docker tasks=20 workers=2 node=22 TBENCH_DIR=/path/to/Testsuite_tasks validators=on
```

### Validator Modes

`BENCH_VALIDATOR_MODE` controls how task validation runs:

- **posthoc** (default): After the 55NDeep correction loop finishes, the benchmark script runs the TBench validator against the run directory. This is the original behavior and produces `validation.kind: "tbench"`.
- **native**: The benchmark passes `--validator` to the 55NDeep CLI, which calls the TBench validator inline during the correction loop. The CLI decides `sourceOfTruth: "task-validator"` and includes `finalVerdict`, `taskValidation`, `taskOutcome`, and `taskPass` directly in the CLI JSON output. Rows in native mode include `finalAction`, `finalVerdict`, `sourceOfTruth`, `verifierOverall`, `taskValidation`, `taskOutcome`, and `taskPass`.

In native mode the outer exec timeout is set to `VALIDATOR_TIMEOUT_MS + (MAX_CORRECTIONS + 1) * MODEL_TIMEOUT_MS + 120s` so the process is not killed before the validator finishes.

Use `VALIDATOR_BACKEND=docker` for real evidence.

Use `INCLUDE_SOLO=0` unless explicitly testing the solo baseline. Solo calls consume tokens and have not been the main signal.

Use `KEEP_RUNS=1` only for debugging. It leaves temp dirs under `/tmp`.

## Current Model Matrix Run

Run this now. This is the current requested pass:

```bash
./bench/run-model-matrix.sh
```

If the run needed active babysitting, include it:

```bash
TBENCH_DIR=/path/to/Testsuite_tasks OVERSIGHT_TOKENS=12000 OVERSIGHT_MINUTES=45 OVERSIGHT_ACTOR=codex OVERSIGHT_NOTES="guide update, run selection, result triage" ./bench/run-model-matrix.sh
```

Do not put secrets in `OVERSIGHT_NOTES`.

Purpose:

- compare two anchors against four new challengers on the same fixed 4-task panel
- keep RNJ as cheap baseline and GLM 4.7 as reliability anchor
- test coder/reasoning challengers without changing task mix
- measure drift on `broken-python` and `form-filling`

Chosen workers:

```text
rnj-1:8b-cloud
glm-4.7:cloud
qwen3-coder-next:cloud
glm-5.1:cloud
deepseek-v4-flash:cloud
gpt-oss:120b-cloud
```

Do not run the old 3-task / 4-worker baseline for this pass unless explicitly asked.

## Recommended OpenCode Assignment

Give OpenCode this instruction:

```text
Work in /path/to/runtime-sandbox only.

Run the real TBench benchmark using Docker validators. Do not modify source code unless the benchmark runner itself crashes from an obvious local bug. Do not run from /path/to/publish-repo.

Start with the current model matrix run:

./bench/run-model-matrix.sh

Do not run the old 3-task / 4-worker baseline unless explicitly asked.

When finished, inspect the newest /tmp/bench-sandbox/report-real-*.json and write a concise report to:

/path/to/runtime-sandbox/bench/opencode-run-report.md

The report must include:
- exact command run
- report JSON path
- per-worker taskPass count
- per-task matrix
- token totals per worker
- workerTokensPerTaskPass and totalTokensPerTaskPass from `summary.accounting`
- oversight tokens/minutes/actor/notes, or explicitly `0` if no babysitting was counted
- failures classified as candidate_fail, validator_infra_fail, cloud_timeout_or_empty, or unknown
- the last useful validation.output lines for each failure
- rank workers by taskPass, then tokens
- identify which workers pass `broken-python`
- identify which workers pass `form-filling`
- classify cloud zero-token/timeouts separately from candidate failures
- whether finalAction still disagrees with taskPass

Do not include secrets or .env contents.
```

## Follow-up Matrix

Only after the current model matrix completes, and only if cloud is stable, rerun the top two or three workers on a longer task set. Do not spend more tokens on models that lose the fixed panel.

The raw command behind `run-model-matrix.sh` is:

```bash
sg docker -c 'TBENCH_DIR=/path/to/Testsuite_tasks VALIDATOR_BACKEND=docker INCLUDE_SOLO=0 MAX_CORRECTIONS=3 TASKS=simple-web-scraper,csv-to-parquet,broken-python,form-filling WORKERS=rnj-1:8b-cloud,glm-4.7:cloud,qwen3-coder-next:cloud,glm-5.1:cloud,deepseek-v4-flash:cloud,gpt-oss:120b-cloud node bench/real-tbench-benchmark.mjs'
```

Avoid `simple-sql-query` in real-pass comparisons for now. The latest run showed `missing-validator`, so it is not valid evidence until a validator path is added.

Older broader idea, only if model names are confirmed:

```bash
sg docker -c 'TBENCH_DIR=/path/to/Testsuite_tasks VALIDATOR_BACKEND=docker INCLUDE_SOLO=0 TASKS=simple-web-scraper,csv-to-parquet,broken-python,simple-sql-query,form-filling WORKERS=rnj-1:8b-cloud,glm-4.7:cloud,gpt-oss:120b-cloud,qwen3.5:cloud node bench/real-tbench-benchmark.mjs'
```

Use `gpt-oss:120b-cloud` for the GPT-OSS cloud worker. Do not shorten it to `gpt-oss:cloud`; Ollama resolves that as missing `gpt-oss` and the run becomes an endpoint/name failure, not a model-quality result.

## Historical Baseline

Do not run this for the current overnight pass. It is here only for comparison:

```bash
sg docker -c 'TBENCH_DIR=/path/to/Testsuite_tasks VALIDATOR_BACKEND=docker INCLUDE_SOLO=0 TASKS=simple-web-scraper,csv-to-parquet,broken-python WORKERS=rnj-1:8b-cloud,glm-4.7:cloud,deepseek-v3.2:cloud,minimax-m2.7:cloud node bench/real-tbench-benchmark.mjs'
```

Stable historical result:

```text
glm-4.7:cloud passed 3/3
rnj-1:8b-cloud passed simple-web-scraper and csv-to-parquet, failed broken-python
deepseek-v3.2:cloud generally passes simple tasks and fails broken-python
minimax-m2.7:cloud is unstable across simple-web-scraper and broken-python
```

## Latest GLM Overnight Run

Report:

```text
/tmp/bench-sandbox/report-real-1778623188647.json
```

Summary report:

```text
bench/opencode-run-report-glm-4task.md
```

Command:

```bash
sg docker -c 'TBENCH_DIR=/path/to/Testsuite_tasks VALIDATOR_BACKEND=docker INCLUDE_SOLO=0 MAX_CORRECTIONS=3 TASKS=simple-web-scraper,csv-to-parquet,broken-python,form-filling WORKERS=glm-4.7:cloud node bench/real-tbench-benchmark.mjs'
```

Summary:

```text
simple-web-scraper  PASS
csv-to-parquet      PASS
broken-python       FAIL
form-filling        FAIL
```

Totals:

```text
glm-4.7:cloud  2/4 task-pass | 16,877 tokens | 4 files | 263s
```

Interpretation:

- GLM still handles the simple Python tasks.
- GLM did not reliably hold `broken-python`; this run was a real candidate failure, not a zero-token/cloud failure.
- `form-filling` failed from candidate behavior: wrong PDF import (`PyPDF2` instead of installed `pypdf`) and no output JSON.
- `finalAction` was still `escalate` on all tasks, including the two real passes. This confirms the next harness issue: task validator success needs to override or annotate internal verifier failure.

## Latest Model Matrix Run

Report:

```text
/tmp/bench-sandbox/report-real-1778629405500.json
```

Summary report:

```text
bench/opencode-run-report-model-matrix.md
```

Command:

```bash
./bench/run-model-matrix.sh
```

Summary:

```text
glm-5.1:cloud              3/4 | 4,951 tokens | 355s
deepseek-v4-flash:cloud    3/4 | 7,258 tokens | 45s
glm-4.7:cloud              2/4 | 10,750 tokens
rnj-1:8b-cloud             1/4 | 2,744 tokens
qwen3-coder-next:cloud     1/4 | 4,580 tokens
gpt-oss:cloud              0/4 | 0 tokens, no files (invalid model name; rerun as gpt-oss:120b-cloud before scoring)
```

Task notes:

- `simple-web-scraper`: all nonzero-output workers passed
- `csv-to-parquet`: GLM 4.7, GLM 5.1, and DeepSeek V4 Flash passed
- `broken-python`: only GLM 5.1 and DeepSeek V4 Flash passed
- `form-filling`: 0/6 passed

Interpretation:

- GLM 5.1 is the current top token-efficient reliability candidate.
- DeepSeek V4 Flash is the current top speed candidate among 3/4 passers.
- GLM 4.7 is no longer stable on `broken-python`.
- `form-filling` remains the hard drift task; failures cluster around unavailable `fitz`/PyMuPDF or `PyPDF2` imports instead of using installed `pypdf`.
- `gpt-oss:cloud` was an invalid model designation in that run. Rerun as `gpt-oss:120b-cloud` before using GPT-OSS in scoreboards.

## Prior Drift Run

Report:

```text
/tmp/bench-sandbox/report-real-1778614476497.json
```

Summary report: historical drift run (no longer tracked as raw JSON)

Command shape:

```text
5 tasks x 4 workers, INCLUDE_SOLO=0, MAX_CORRECTIONS=3, Docker validators
```

Summary:

```text
simple-web-scraper  4/4 PASS
csv-to-parquet      4/4 PASS
broken-python       0/4 PASS in this run; GLM and DeepSeek had zero-token/no-file failures
simple-sql-query    SKIP across all workers; missing validator trio
form-filling        0/4 PASS
```

Interpretation:

- fence/prose cleanup did not hurt simple Python tasks; it likely helped drift resistance
- `broken-python` remains the key dependency-repair separator, but cloud zero-token failures must be separated from model quality
- `form-filling` is a harder drift/format stress task and needs failure inspection
- `simple-sql-query` should be excluded from real-pass scoreboards until it has a validator

## Avoid Heavy Tasks First

Do not start with these unless explicitly asked:

```text
create-bucket
build-cython-ext
cross-entropy-method
blind-maze-explorer-5x5
catch-me-if-you-can
```

Reasons:

- large Docker image pulls
- localstack setup
- long dependency installs
- noisy infra failures that obscure model comparison

## Quick Report Parser

After a run, find the newest report:

```bash
ls -t /tmp/bench-sandbox/report-real-*.json | head -1
```

Print compact per-result rows:

```bash
node -e "const f=require('child_process').execSync('ls -t /tmp/bench-sandbox/report-real-*.json | head -1').toString().trim(); const r=require(f); console.log('REPORT',f); for (const x of r.allResults) console.log([x.mode,x.task,x.taskPass===true?'PASS':'FAIL',x.finalAction,x.tokens,x.filesCreated,x.validation?.kind,String(x.validation?.output||'').replace(/\n/g,' ').slice(-180)].join('\t'));"
```

Print per-worker summary:

```bash
node -e "const f=require('child_process').execSync('ls -t /tmp/bench-sandbox/report-real-*.json | head -1').toString().trim(); const r=require(f); for (const m of [...new Set(r.allResults.map(x=>x.mode))]) { const a=r.allResults.filter(x=>x.mode===m); console.log(m,{taskPass:a.filter(x=>x.taskPass===true).length+'/'+a.length, cliAccept:a.filter(x=>x.finalAction==='accept').length+'/'+a.length, tokens:a.reduce((s,x)=>s+(x.tokens||0),0), files:a.reduce((s,x)=>s+(x.filesCreated||0),0), sec:Math.round(a.reduce((s,x)=>s+(x.durationMs||0),0)/1000)}); }"
```

## Failure Classification

Use these labels in reports:

```text
candidate_fail
```

The validator ran normally and the emitted files failed the task tests.

```text
validator_infra_fail
```

Docker, pip, pytest install, task setup, localstack, permissions, or task harness failed before meaningfully testing the candidate.

```text
cloud_timeout_or_empty
```

Model returned no content, zero tokens, timeout, or API transport failure.

```text
unknown
```

Not enough evidence in the report tail.

Do not count `validator_infra_fail` or `cloud_timeout_or_empty` as model-quality failures. Keep them visible and separate.

## Stop Conditions

Stop the run and report status if:

- Docker image pull/build is stuck for more than 20 minutes on one task
- Ollama Cloud returns repeated empty responses across multiple workers
- the benchmark produces no report JSON
- `/tmp` starts filling aggressively
- the runner begins modifying source files unexpectedly

Check temp usage:

```bash
du -sh /tmp/bench-sandbox /tmp/bench-* 2>/dev/null
```

Clean preserved/debug runs only if explicitly allowed:

```bash
find /tmp -maxdepth 1 -type d -name 'bench-*' -mtime +1
```

## Expected Output File

OpenCode should write:

```text
/path/to/runtime-sandbox/bench/opencode-run-report.md
```

Use this structure:

```markdown
# OpenCode Real TBench Run

## Command

## Report JSON

## Summary

## Matrix

## Failures

## Comparison To Prior Run

## Notes
```

Keep it factual. No marketing language. No claims stronger than the validators support.

## Interpretation Rules

Good evidence:

- `taskPass: true`
- `validation.kind: "tbench"`
- emitted files present
- nonzero token count
- report JSON preserved

Weak evidence:

- `finalAction: "accept"` without `taskPass: true`
- syntax-only checks
- local fallback validator when Docker was expected
- zero-token model output
- setup failure that never ran the real task assertions

The claim we are trying to validate is:

```text
Verifier-guided cheap workers can produce more real passing artifacts per token than naive solo prompting.
```

Not:

```text
The harness solved everything.
```

## Generated Output Policy

Raw benchmark JSON and log outputs (`report-real-*.json`, `drift-run-*.log`, `*-run-*.log`) are generated artifacts and are intentionally gitignored. Publish sanitized summaries in markdown instead. The curated reports in this guide are historical summaries, not tracked raw data.

## Current Useful Files

```text
bench/real-tbench-benchmark.mjs      real validator benchmark runner
bench/SCAVENGE_REPORT.md             notes from earlier report scavenging
bench/task-fixes/                    local validator patch notes/scripts
bench/results/                       sanitized benchmark result summaries
scripts/sync-to-sandbox.sh           push tracked files to sandbox
scripts/check-clean-publish-repo.sh  verify no runtime artifacts in publish repo
scripts/run-225-native-worker.sh     overnight native benchmark runner for .225
```

### .225 Worker Run Script

For overnight runs on the .225 worker, use `scripts/run-225-native-worker.sh`:

```bash
# Minimal smoke test
WORKERS=rnj-1:8b-cloud TASKS=hello-world ./scripts/run-225-native-worker.sh

# Full overnight run (examples — do not hardcode models)
WORKERS=rnj-1:8b-cloud,gpt-oss:120b-cloud ./scripts/run-225-native-worker.sh
```

The script sets `BENCH_VALIDATOR_MODE=native`, `RUN_VALIDATORS=1`, `VALIDATOR_BACKEND=docker`, `INCLUDE_SOLO=0`, and `MAX_CORRECTIONS=2` by default. It sources nvm and selects Node 22, uses `sg docker` when needed, and prints the full config before starting. `WORKERS` is required; `TBENCH_DIR` defaults to the archived task corpus.

### Cheap Smoke Test

To quickly verify native validator mode works end-to-end with minimal cost:

```bash
TBENCH_DIR=/path/to/Testsuite_tasks \
  TASKS=hello-world \
  WORKERS=rnj-1:8b-cloud \
  BENCH_VALIDATOR_MODE=native \
  RUN_VALIDATORS=1 \
  INCLUDE_SOLO=0 \
  node bench/real-tbench-benchmark.mjs
```

This runs a single task with one worker in native mode. Use it to confirm the `--validator` path, timeout handling, and result fields are wired correctly before running a full matrix.
