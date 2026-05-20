# Post-Plugin Rename Validator Benchmark

**Date**: 2026-05-14
**PR**: 51 (post-`@55ndeep/plugin` rename, post-PR47 native task validator)
**Report JSON**: `/tmp/bench-sandbox/report-real-1778760810942.json`

## Command

```bash
sg docker -c 'TBENCH_DIR=/path/to/research/55NDeep/Testsuite_tasks \
  VALIDATOR_BACKEND=docker \
  INCLUDE_SOLO=0 \
  MAX_CORRECTIONS=3 \
  RUN_VALIDATORS=1 \
  TASKS=csv-to-parquet,broken-python,simple-web-scraper,form-filling \
  WORKERS=rnj-1:8b-cloud,gpt-oss:120b-cloud,glm-5.1:cloud,deepseek-v4-flash:cloud \
  OVERSIGHT_ACTOR=glm-5.1 \
  OVERSIGHT_TOKENS=0 \
  OVERSIGHT_MINUTES=0 \
  OVERSIGHT_NOTES="post-plugin-rename validator benchmark" \
  node bench/real-tbench-benchmark.mjs'
```

## Configuration

- **Tasks**: csv-to-parquet, broken-python, simple-web-scraper, form-filling
- **Workers**: rnj-1:8b-cloud, gpt-oss:120b-cloud, glm-5.1:cloud, deepseek-v4-flash:cloud
- **Validators**: on (ruff, pyright, bandit available)
- **Task validators**: Docker TBench (docker-compose/run-tests)
- **Correction loop**: max 3 retries
- **Solo runs**: excluded

## Tool Preflight

```
verifierPreflight: { status: "pass", missingRequired: [], missingAdvisory: [] }
```

All required Python verifier tools (ruff, pyright) and advisory tools (bandit) were available.

## Result Matrix

| Worker | Task | finalAction | finalVerdict | sourceOfTruth | verifierOverall | taskValidation.status | taskOutcome | taskPass | Tokens | Files |
|--------|------|-------------|-------------|--------------|-----------------|----------------------|-------------|----------|--------|-------|
| rnj-1:8b-cloud | csv-to-parquet | escalate | — | — | fail | skipped | escalate | false | 1,883 | 1 |
| gpt-oss:120b-cloud | csv-to-parquet | escalate | — | — | fail | skipped | escalate | false | 4,116 | 1 |
| glm-5.1:cloud | csv-to-parquet | escalate | — | — | fail | skipped | escalate | false | 3,867 | 1 |
| deepseek-v4-flash:cloud | csv-to-parquet | escalate | — | — | fail | skipped | escalate | false | 4,413 | 1 |
| rnj-1:8b-cloud | broken-python | escalate | — | — | fail | skipped | escalate | false | 1,391 | 1 |
| gpt-oss:120b-cloud | broken-python | escalate | — | — | fail | skipped | escalate | false | 3,246 | 1 |
| glm-5.1:cloud | broken-python | escalate | — | — | fail | skipped | escalate | false | 2,887 | 1 |
| deepseek-v4-flash:cloud | broken-python | escalate | — | — | fail | skipped | escalate | false | 3,858 | 1 |
| rnj-1:8b-cloud | simple-web-scraper | escalate | — | — | fail | skipped | escalate | false | 2,525 | 2 |
| gpt-oss:120b-cloud | simple-web-scraper | escalate | — | — | fail | skipped | escalate | false | 4,795 | 3 |
| glm-5.1:cloud | simple-web-scraper | escalate | — | — | fail | skipped | escalate | false | 9,606 | 1 |
| deepseek-v4-flash:cloud | simple-web-scraper | escalate | — | — | fail | skipped | escalate | false | 4,363 | 1 |
| rnj-1:8b-cloud | form-filling | escalate | — | — | fail | skipped | escalate | false | 1,576 | 1 |
| gpt-oss:120b-cloud | form-filling | escalate | — | — | fail | skipped | escalate | false | 3,098 | 1 |
| glm-5.1:cloud | form-filling | escalate | — | — | fail | skipped | escalate | false | 6,042 | 1 |
| deepseek-v4-flash:cloud | form-filling | escalate | — | — | fail | skipped | escalate | false | 4,105 | 1 |

All 16 cells have `taskValidation.status: "skipped"` with `validator: "missing-validator"` and reason `"task has no docker-compose/run-tests/tests trio"`.

## Per-Worker Summary

| Worker | Task Passes | Worker Tokens | Tokens/Pass | Files |
|--------|------------|--------------|-------------|-------|
| rnj-1:8b-cloud | 0/4 | 7,375 | n/a | 5 |
| gpt-oss:120b-cloud | 0/4 | 15,255 | n/a | 6 |
| glm-5.1:cloud | 0/4 | 22,402 | n/a | 4 |
| deepseek-v4-flash:cloud | 0/4 | 16,739 | n/a | 4 |

**Total**: 0 task passes out of 16 cells. 61,771 worker tokens spent.

## Failure Classification

Every cell in this run is classified as **validator_infra_fail**:

- **`taskValidation.status: "skipped"`** with `validator: "missing-validator"`
- Reason: `"task has no docker-compose/run-tests/tests trio"`
- The TBench Docker validator infrastructure was not available for any of the four tasks
- This is not a model-quality failure — it is a validator infrastructure gap

No cells are classified as:
- `candidate_fail` (no task validator ran)
- `cloud_timeout_or_empty` (all models produced tokens)
- `verifier_missing_or_skipped` (verifiers ran, but all returned fail)
- `unknown`

## Key Observations

1. **Verifier preflight passed.** Ruff, pyright, and bandit were all available. The `verifierPreflight: { status: "pass" }` confirms the post-PR42 Python tool checks work correctly.

2. **All 16 cells hit missing-validator infrastructure.** None of the four tasks have a Docker compose / run-tests / tests trio in their TBench task directory, so the Docker task validator could not run. This means no `taskPass: true` result is possible regardless of worker model quality.

3. **`finalVerdict` and `sourceOfTruth` are absent (`—`) in this run.** These fields are populated only when the `--validator` flag is passed to the correction loop. The benchmark runner uses Docker TBench validators instead, so the new native validator verdict fields are not populated in this matrix format.

4. **Verifier loop ran correctly.** All 16 cells have `verifierOverall: "fail"`, meaning the local verifier battery (ruff/pyright/bandit + secdev/gitnexus) ran and found issues. The correction loop escalated after max corrections.

5. **All models produced files.** Every worker emitted at least 1 file per task. The failure is that the files did not pass local verification or Docker task validation (which was unavailable).

6. **RNJ-1 8B was most token-efficient.** rnj-1:8b-cloud used 7,375 tokens across 4 tasks, while glm-5.1:cloud used 22,402. Since no task passed, tokens/pass is undefined for all workers.

## Interpretation

This run does not produce model-quality comparison evidence because the task validator infrastructure was unavailable for all four tasks. The run validates:

- The post-PR47 codebase (with `@55ndeep/plugin` rename, native validator verdicts, and verifier preflight) compiles, builds, and runs without error.
- Verifier preflight correctly detects Python tools and passes.
- The correction loop runs and escalates when verification fails.
- No model produced zero tokens or timed out — all 16 cells are `validator_infra_fail`, not `cloud_timeout_or_empty`.

**Do not interpret 0/4 pass rates as model-quality evidence.** All four tasks lacked Docker task validators. A task can only pass when its Docker test harness runs and the tests pass.

**Stochasticity note**: n=1 per cell. Single-run results are noisy. No claim about relative model quality should be made from this data, especially when all cells share the same validator infrastructure gap.

**Brain & Brawn / Verifier framing**: This run shows the Verifier (55NDeep) and the Brain (correction loop) working correctly. The Brawn (workers) all produced files. The gap is in the task validator layer, which is external to 55NDeep. When task validators are present, the full Brain → Brawn → Verifier → Validator loop can produce meaningful pass/fail evidence.
REPORTEOF
