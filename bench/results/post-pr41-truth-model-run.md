# Post-PR41 Truth-Model Evidence Run

**Run timestamp:** 2026-05-14T04:57:17.115Z

## Command / Env Summary

```
TBENCH_DIR=/path/to/research/55NDeep/Testsuite_tasks
VALIDATOR_BACKEND=docker
INCLUDE_SOLO=0
MAX_CORRECTIONS=3
TASKS=simple-web-scraper,csv-to-parquet,broken-python,form-filling
WORKERS=rnj-1:8b-cloud,glm-4.7:cloud,glm-5.1:cloud,deepseek-v4-flash:cloud,gpt-oss:cloud,qwen3-coder-next:cloud
OVERSIGHT_ACTOR=glm-5.1
OVERSIGHT_TOKENS=45000
OVERSIGHT_MINUTES=90
OVERSIGHT_NOTES="fresh post-PR41 truth-model evidence run"
```

Runner: `bench/real-tbench-benchmark.mjs` from sandbox working copy at `/path/to/runtime-sandbox` (CLI built at `apps/cli/dist/index.js`).

## Tasks

| # | Task |
|---|------|
| 1 | simple-web-scraper |
| 2 | csv-to-parquet |
| 3 | broken-python |
| 4 | form-filling |

## Workers

| # | Worker |
|---|--------|
| 1 | rnj-1:8b-cloud |
| 2 | glm-4.7:cloud |
| 3 | glm-5.1:cloud |
| 4 | deepseek-v4-flash:cloud |
| 5 | gpt-oss:cloud |
| 6 | qwen3-coder-next:cloud |

## Results

| Worker | Task | finalAction | verifierOverall | taskValidation.status | taskOutcome | taskPass | Tokens | Files | Validation Kind | Validation Detail |
|--------|------|-------------|-----------------|----------------------|-------------|----------|--------|-------|-----------------|-------------------|
| rnj-1:8b-cloud | simple-web-scraper | escalate | fail | pass | pass | true | 4,148 | 1 | tbench | exitCode=0, 5/5 tests passed |
| glm-4.7:cloud | simple-web-scraper | escalate | fail | pass | pass | true | 15,965 | 1 | tbench | exitCode=0, 5/5 tests passed |
| glm-5.1:cloud | simple-web-scraper | escalate | fail | pass | pass | true | 7,416 | 1 | tbench | exitCode=0, 5/5 tests passed |
| deepseek-v4-flash:cloud | simple-web-scraper | escalate | fail | pass | pass | true | 6,146 | 1 | tbench | exitCode=0, 5/5 tests passed |
| gpt-oss:cloud | simple-web-scraper | unknown | unknown | fail | fail | false | 0 | 0 | tbench | no candidate files emitted; model not found |
| qwen3-coder-next:cloud | simple-web-scraper | escalate | fail | pass | pass | true | 4,625 | 1 | tbench | exitCode=0, 5/5 tests passed |
| rnj-1:8b-cloud | csv-to-parquet | escalate | fail | pass | pass | true | 1,686 | 1 | tbench | exitCode=0, 2/2 tests passed |
| glm-4.7:cloud | csv-to-parquet | escalate | fail | pass | pass | true | 7,607 | 1 | tbench | exitCode=0, 2/2 tests passed |
| glm-5.1:cloud | csv-to-parquet | escalate | fail | pass | pass | true | 3,579 | 1 | tbench | exitCode=0, 2/2 tests passed |
| deepseek-v4-flash:cloud | csv-to-parquet | escalate | fail | pass | pass | true | 2,503 | 1 | tbench | exitCode=0, 2/2 tests passed |
| gpt-oss:cloud | csv-to-parquet | unknown | unknown | fail | fail | false | 0 | 0 | tbench | no candidate files emitted; model not found |
| qwen3-coder-next:cloud | csv-to-parquet | escalate | fail | pass | pass | true | 1,453 | 1 | tbench | exitCode=0, 2/2 tests passed |
| rnj-1:8b-cloud | broken-python | escalate | fail | fail | fail | false | 2,345 | 1 | tbench | exitCode=1, ModuleNotFoundError: No module named 'pip' |
| glm-4.7:cloud | broken-python | escalate | fail | pass | pass | true | 21,984 | 4 | tbench | exitCode=0, tests passed |
| glm-5.1:cloud | broken-python | escalate | fail | pass | pass | true | 8,618 | 1 | tbench | exitCode=0, tests passed |
| deepseek-v4-flash:cloud | broken-python | escalate | fail | fail | fail | false | 5,803 | 1 | tbench | exitCode=1, ModuleNotFoundError: No module named 'pip' |
| gpt-oss:cloud | broken-python | unknown | unknown | fail | fail | false | 0 | 0 | tbench | no candidate files emitted; model not found |
| qwen3-coder-next:cloud | broken-python | escalate | fail | fail | fail | false | 3,186 | 1 | tbench | exitCode=1, ModuleNotFoundError: No module named 'pip' |
| rnj-1:8b-cloud | form-filling | escalate | fail | fail | fail | false | 5,226 | 1 | tbench | exitCode=1, ModuleNotFoundError: No module named 'PyPDF2' |
| glm-4.7:cloud | form-filling | escalate | fail | fail | fail | false | 32,334 | 9 | tbench | exitCode=1, JSON missing pdf_file key; KeyError total_mapped |
| glm-5.1:cloud | form-filling | escalate | fail | fail | fail | false | 35,788 | 7 | tbench | exitCode=1, ModuleNotFoundError: No module named 'PyPDF2' |
| deepseek-v4-flash:cloud | form-filling | escalate | fail | fail | fail | false | 13,527 | 1 | tbench | exitCode=1, ModuleNotFoundError: No module named 'PyPDF2' |
| gpt-oss:cloud | form-filling | unknown | unknown | fail | fail | false | 0 | 0 | tbench | no candidate files emitted; model not found |
| qwen3-coder-next:cloud | form-filling | escalate | fail | fail | fail | false | 12,303 | 3 | tbench | exitCode=1, SyntaxError in form_filler.py; field_mapping.json not created |

## Per-Worker Summary

| Worker | taskPass | taskFailures | taskEscalations | verifierPasses | verifierFails | cliAccepts | workerTokens | totalTokensPerTaskPass |
|--------|----------|-------------|-----------------|---------------|--------------|------------|-------------|----------------------|
| rnj-1:8b-cloud | 2 | 2 | 4 | 0 | 4 | 0 | 13,405 | 6,703 |
| glm-4.7:cloud | 3 | 1 | 4 | 0 | 4 | 0 | 77,890 | 25,963 |
| glm-5.1:cloud | 3 | 1 | 4 | 0 | 4 | 0 | 55,401 | 18,467 |
| deepseek-v4-flash:cloud | 2 | 2 | 4 | 0 | 4 | 0 | 27,979 | 13,990 |
| gpt-oss:cloud | 0 | 4 | 0 | 0 | 0 | 0 | 0 | n/a |
| qwen3-coder-next:cloud | 2 | 2 | 4 | 0 | 4 | 0 | 21,567 | 10,784 |
| **Totals** | **12** | **12** | **20** | **0** | **20** | **0** | **196,242** | — |

Note: verifierOverall counts reflect the last verification status in each run's turn breakdown. All workers with turns had verification=fail on every turn; gpt-oss had no turns at all. taskEscalations counts runs where finalAction=escalate.

## Oversight Accounting

| Field | Value |
|-------|-------|
| Oversight Actor | glm-5.1 |
| Oversight Tokens | 45,000 |
| Oversight Minutes | 90 |
| Oversight Notes | fresh post-PR41 truth-model evidence run |
| Worker Tokens | 196,242 |
| Total Tokens (worker + oversight) | 241,242 |
| Total Task Passes | 12 |
| Total Tokens per Task Pass | 20,104 |

## Failure Classification

| Classification | Count | Runs |
|---------------|-------|------|
| candidate_fail | 9 | rnj-1:8b/broken-python, rnj-1:8b/form-filling, deepseek-v4-flash/broken-python, deepseek-v4-flash/form-filling, qwen3-coder-next/broken-python, qwen3-coder-next/form-filling, glm-4.7/form-filling, glm-5.1/form-filling, rnj-1:8b/form-filling (counted per row — 9 total taskValidation.status=fail with files produced) |
| validator_infra_fail | 0 | — |
| cloud_timeout_or_empty | 4 | gpt-oss:cloud on all 4 tasks (model not found, 0 tokens, no output) |
| missing_validator | 0 | — |
| unknown | 0 | — |

### Failure Detail

- **candidate_fail** (9 runs): Worker produced files but task validator rejected them. Includes: broken-python failures where `pip` module was not restored correctly (3 runs), and form-filling failures where PyPDF2 was missing, JSON schema was wrong, or syntax errors in output (6 runs).
- **cloud_timeout_or_empty** (4 runs): gpt-oss model returned `not_found_error` immediately with 0 tokens on every task.

## Important Notes

> **finalAction is not task success.** finalAction represents the CLI orchestrator's routing decision (escalate/accept/correct). In this run, every completed run ended with `escalate` — meaning the internal verifier never signaled a pass — yet several tasks nevertheless passed the independent tbench validator. This demonstrates the core truth-model distinction: the internal verifier can fail a run while the task itself passes.
>
> **taskPass only means taskValidation.status === "pass".** It carries no implication about verifierOverall or finalAction. A task can pass even when the verifier judged every correction turn as a failure and escalated.

## Cross-Check Highlights

- 12 out of 24 runs achieved taskPass=true (50%).
- 0 out of 24 runs had a verifier pass at any turn (verifierOverall=fail or unknown for all).
- 0 out of 24 runs had finalAction=accept.
- The disconnect between verifierOverall and taskPass is the expected truth-model behavior: the internal verifier is intentionally conservative, and task validation is the authoritative metric for task success.
- gpt-oss:cloud is a non-functional worker (model not found) and should be excluded from meaningful pass-rate calculations.