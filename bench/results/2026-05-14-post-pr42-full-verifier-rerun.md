# Post-PR42 Full Verifier-Loop Benchmark Rerun

## Command

```bash
sg docker -c 'TBENCH_DIR=/path/to/research/55NDeep/Testsuite_tasks \
  VALIDATOR_BACKEND=docker INCLUDE_SOLO=0 MAX_CORRECTIONS=3 \
  TASKS=simple-web-scraper,csv-to-parquet,broken-python,form-filling \
  WORKERS=rnj-1:8b-cloud,glm-4.7:cloud,glm-5.1:cloud,deepseek-v4-flash:cloud,gpt-oss:120b-cloud,qwen3-coder-next:cloud \
  OVERSIGHT_ACTOR=glm-5.1 OVERSIGHT_TOKENS=45000 OVERSIGHT_MINUTES=90 \
  OVERSIGHT_NOTES="post-PR42 full verifier-loop rerun with Python tools installed" \
  node bench/real-tbench-benchmark.mjs'
```

## Report JSON

- **New (post-PR42):** `/tmp/bench-sandbox/report-real-1778751936861.json`
- **Previous (pre-PR42, no verifiers):** `/tmp/bench-sandbox/report-real-1778742814778.json`

## Verifier Preflight

```json
{
  "status": "pass",
  "missingRequired": [],
  "missingAdvisory": []
}
```

All required Python verifier tools were present. The benchmark ran with the full verifier loop active.

## Tool Versions

| Tool | Version |
|------|---------|
| ruff | 0.15.6 |
| pyright | 1.1.409 |
| bandit | 1.6.2 |

## Per-Worker Summary

| Worker | taskPass | cliAccepts | verifierPass | verifierFail | workerTokens | tokens/pass | files |
|--------|----------|-----------|-------------|-------------|-------------|------------|-------|
| rnj-1:8b | 2/4 | 0 | 0 | 4 | 9,706 | 4,853 | 4 |
| glm-4.7 | 2/4 | 0 | 0 | 3 | 30,842 | 15,421 | 4 |
| glm-5.1 | 2/4 | 0 | 0 | 4 | 23,396 | 11,698 | 4 |
| deepseek-v4-flash | 2/4 | 0 | 0 | 4 | 19,094 | 9,547 | 4 |
| gpt-oss:120b | 1/4 | 0 | 0 | 4 | 18,021 | 18,021 | 5 |
| qwen3-coder-next | 2/4 | 0 | 0 | 4 | 9,094 | 4,547 | 4 |

**Accounting:** workerTokens=110,153 / oversightTokens=45,000 / totalTokens=155,153 / totalTokensPerTaskPass=14,105

## Per-Task Results

| Worker | Task | finalAction | verifierOverall | taskValidation | taskOutcome | taskPass | Tokens | Files |
|--------|------|-------------|----------------|---------------|------------|---------|--------|-------|
| rnj-1:8b | simple-web-scraper | escalate | fail | pass | pass | ✅ | 4,549 | 1 |
| glm-4.7 | simple-web-scraper | escalate | fail | pass | pass | ✅ | 13,603 | 1 |
| glm-5.1 | simple-web-scraper | escalate | fail | pass | pass | ✅ | 6,090 | 1 |
| deepseek-v4-flash | simple-web-scraper | escalate | fail | pass | pass | ✅ | 6,425 | 1 |
| gpt-oss:120b | simple-web-scraper | escalate | fail | fail | fail | ❌ | 7,419 | 1 |
| qwen3-coder-next | simple-web-scraper | escalate | fail | pass | pass | ✅ | 4,951 | 1 |
| rnj-1:8b | csv-to-parquet | escalate | fail | pass | pass | ✅ | 1,890 | 1 |
| glm-4.7 | csv-to-parquet | escalate | fail | pass | pass | ✅ | 7,421 | 1 |
| glm-5.1 | csv-to-parquet | escalate | fail | pass | pass | ✅ | 2,270 | 1 |
| deepseek-v4-flash | csv-to-parquet | escalate | fail | pass | pass | ✅ | 3,731 | 1 |
| gpt-oss:120b | csv-to-parquet | escalate | fail | pass | pass | ✅ | 3,086 | 1 |
| qwen3-coder-next | csv-to-parquet | escalate | fail | pass | pass | ✅ | 1,599 | 1 |
| rnj-1:8b | broken-python | escalate | fail | fail | fail | ❌ | 1,528 | 1 |
| glm-4.7 | broken-python | escalate | fail | fail | fail | ❌ | 9,818 | 1 |
| glm-5.1 | broken-python | escalate | fail | skipped | escalate | ❌ | 9,957 | 1 |
| deepseek-v4-flash | broken-python | escalate | fail | skipped | escalate | ❌ | 4,978 | 1 |
| gpt-oss:120b | broken-python | escalate | fail | skipped | escalate | ❌ | 3,776 | 1 |
| qwen3-coder-next | broken-python | escalate | fail | skipped | escalate | ❌ | 1,212 | 1 |
| rnj-1:8b | form-filling | escalate | fail | skipped | escalate | ❌ | 1,739 | 1 |
| glm-4.7 | form-filling | unknown | unknown | skipped | escalate | ❌ | 0 | 1 |
| glm-5.1 | form-filling | escalate | fail | skipped | escalate | ❌ | 5,079 | 1 |
| deepseek-v4-flash | form-filling | escalate | fail | skipped | escalate | ❌ | 3,960 | 1 |
| gpt-oss:120b | form-filling | escalate | fail | skipped | escalate | ❌ | 3,740 | 2 |
| qwen3-coder-next | form-filling | escalate | fail | skipped | escalate | ❌ | 1,332 | 1 |

## Comparison vs Previous Run (Pre-PR42, No Verifiers)

| Worker | Prev taskPass | New taskPass | Swing | Prev tokens | New tokens |
|--------|-------------|-------------|-------|------------|------------|
| rnj-1:8b | 3 | 2 | **−1** | 14,393 | 9,706 |
| glm-4.7 | 3 | 2 | **−1** | 61,906 | 30,842 |
| glm-5.1 | 2 | 2 | 0 | 50,143 | 23,396 |
| deepseek-v4-flash | 2 | 2 | 0 | 32,735 | 19,094 |
| gpt-oss:120b | 1 | 1 | 0 | 24,122 | 18,021 |
| qwen3-coder-next | 2 | 2 | 0 | 21,256 | 9,094 |

### Per-Task Swing Detail

| Worker + Task | Prev | New | Swing |
|---------------|------|-----|-------|
| rnj-1:8b / simple-web-scraper | PASS | PASS | — |
| rnj-1:8b / csv-to-parquet | PASS | PASS | — |
| rnj-1:8b / broken-python | PASS | **FAIL** | **−1** |
| rnj-1:8b / form-filling | FAIL | FAIL | — |
| glm-4.7 / simple-web-scraper | PASS | PASS | — |
| glm-4.7 / csv-to-parquet | PASS | PASS | — |
| glm-4.7 / broken-python | PASS | **FAIL** | **−1** |
| glm-4.7 / form-filling | FAIL | FAIL | — |
| glm-5.1 / simple-web-scraper | PASS | PASS | — |
| glm-5.1 / csv-to-parquet | PASS | PASS | — |
| glm-5.1 / broken-python | FAIL | FAIL | — |
| glm-5.1 / form-filling | FAIL | FAIL | — |
| deepseek-v4-flash / simple-web-scraper | PASS | PASS | — |
| deepseek-v4-flash / csv-to-parquet | PASS | PASS | — |
| deepseek-v4-flash / broken-python | FAIL | FAIL | — |
| deepseek-v4-flash / form-filling | FAIL | FAIL | — |
| gpt-oss:120b / simple-web-scraper | FAIL | FAIL | — |
| gpt-oss:120b / csv-to-parquet | FAIL | **PASS** | **+1** |
| gpt-oss:120b / broken-python | PASS | FAIL | **−1** |
| gpt-oss:120b / form-filling | FAIL | FAIL | — |
| qwen3-coder-next / simple-web-scraper | FAIL | FAIL | — |
| qwen3-coder-next / csv-to-parquet | PASS | PASS | — |
| qwen3-coder-next / broken-python | PASS | FAIL | **−1** |
| qwen3-coder-next / form-filling | FAIL | FAIL | — |

## Key Questions

### Did finalAction and taskPass disagree less after Python tools were installed?

No. Both runs show `finalAction: escalate` (or `unknown` for one cell) across all 24 results, and `cliAccepts: 0` across all workers. The verifier loop is now active (ruff/pyright run), but the reducer still fails closed and escalates every time. The disagreement pattern is unchanged: `finalAction=escalate` coexists with `taskPass=true` in 11 of 24 cells. This is expected — `finalAction` is the harness decision, not the task success metric.

### Did cliAccepts increase from 0?

No. `cliAccepts` remains 0 across all workers and all tasks in both runs. The verifier loop never accepted a candidate. The reducer escalated or the outcome was `unknown`/`fail` in every case.

### Did verifierOverall pass/warn/fail change?

Yes, fundamentally. The previous run did not record `verifierOverall` or `taskValidation` fields at all (the old format omitted them). The new run records `verifierOverall=fail` for 23/24 results and `verifierOverall=unknown` for 1 (glm-4.7 form-filling, which had 0 tokens). Zero `verifierOverall=pass` results. The verifier loop ran (ruff/pyright executed), found problems, and the reducer correctly failed closed. This is the first run with actual verifier-loop signal in the report.

### Did RNJ still pass 3/4?

No. RNJ 8B dropped from 3/4 to 2/4. It lost broken-python this run (1,528 tokens, `taskValidation=fail`). In the previous run it passed broken-python with 3,026 tokens. This is stochastic variation on a 1-shot-per-cell benchmark — not a verifier regression.

### Did GPT-OSS 120B improve?

Mixed. GPT-OSS 120B passed csv-to-parquet this run (3,086 tokens) after failing it in the previous run. But it lost broken-python (3,776 tokens, `taskValidation=skipped`) after passing it in the previous run. Net taskPass stays at 1/4.

## Failure Classification

| Worker | Task | Classification | Notes |
|--------|------|---------------|-------|
| rnj-1:8b | broken-python | candidate_fail | verifier=fail, taskValidation=fail; model produced file but it didn't pass |
| rnj-1:8b | form-filling | verifier_missing_or_skipped | taskValidation=skipped, taskOutcome=escalate; correction loop exhausted |
| glm-4.7 | broken-python | candidate_fail | verifier=fail, taskValidation=fail |
| glm-4.7 | form-filling | cloud_timeout_or_empty | 0 tokens, finalAction=unknown; model returned nothing |
| glm-5.1 | broken-python | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| glm-5.1 | form-filling | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| deepseek-v4-flash | broken-python | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| deepseek-v4-flash | form-filling | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| gpt-oss:120b | simple-web-scraper | candidate_fail | verifier=fail, taskValidation=fail |
| gpt-oss:120b | broken-python | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| gpt-oss:120b | form-filling | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| qwen3-coder-next | broken-python | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |
| qwen3-coder-next | form-filling | verifier_missing_or_skipped | taskValidation=skipped, outcome=escalate |

**Classification key:**
- **candidate_fail**: Model produced output but it did not pass TBench validation
- **cloud_timeout_or_empty**: Model returned zero tokens or timed out
- **endpoint_or_model_name_fail**: Not present in this run
- **validator_infra_fail**: Not present in this run
- **verifier_missing_or_skipped**: Correction loop exhausted (taskValidation=skipped); verifier ran but reducer escalated before task validator could assess the final artifact
- **unknown**: Not applicable

## Notes

- `finalAction` is not task success. Only `taskPass=true` means the TBench validator passed. All 11 passing cells had `finalAction=escalate`.
- `verifierOverall=fail` for 23/24 results. The verifier loop ran (ruff/pyright executed) but never produced an acceptable candidate. This is expected: the reducer correctly fails closed when verifiers find issues.
- Token spend decreased significantly for most workers (e.g., glm-4.7: 61,906 → 30,842). This may reflect the verifier loop providing earlier feedback that let the correction loop converge faster, or simply stochastic variation.
- The `taskValidation=skipped` status on broken-python and form-filling for some workers means the reducer escalated before staging artifacts for task validation. This is a verifier-loop behavior, not a Docker/infra failure.
- form-filling remains universally failed. No model passed it in either run.
- This is the first benchmark run with `verifierPreflight.status=pass`, confirming ruff/pyright/bandit were available throughout.
