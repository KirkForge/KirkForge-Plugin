# Archived TBench Worker Discovery

Date: 2026-05-15  
Raw report: `/tmp/bench-sandbox/report-real-1778802126844.json`  
Generated at: `2026-05-14T23:42:06.843Z`  
Label: **archived TBench post-hoc validator evidence**

## What Ran

This run used the archived validator-capable Harness task set:

```text
TBENCH_DIR=/path/to/research/55NDeep/Testsuite_tasks
```

Configuration:

- 20 archived TBench tasks
- 4 Ollama cloud workers
- `RUN_VALIDATORS=1`
- `INCLUDE_SOLO=0`
- verifier preflight: `pass`
- missing required verifiers: none
- missing advisory verifiers: none

Workers:

- `rnj-1:8b-cloud`
- `gpt-oss:120b-cloud`
- `glm-5.1:cloud`
- `deepseek-v4-flash:cloud`

Important caveat: this benchmark runner still performs **post-hoc TBench validation** after the 55NDeep correction loop. It does not yet use the new native `55ndeep run --validator` runtime path. Therefore the report has real `taskValidation.status` and `taskPass`, but it does not contain `finalVerdict` or `sourceOfTruth`.

## Summary

| Worker | Passes | Fails | Null/Skipped | Worker Tokens | Tokens/Pass | Files | Duration |
|--------|-------:|------:|-------------:|--------------:|------------:|------:|---------:|
| `rnj-1:8b-cloud` | 3 | 17 | 0 | 62,102 | 20,701 | 26 | 14 min |
| `gpt-oss:120b-cloud` | 2 | 18 | 0 | 120,760 | 60,380 | 28 | 27 min |
| `glm-5.1:cloud` | 5 | 15 | 0 | 130,592 | 26,118 | 32 | 83 min |
| `deepseek-v4-flash:cloud` | 4 | 16 | 0 | 131,483 | 32,871 | 20 | 91 min |

Aggregate:

- total cells: 80
- task passes: 14
- task failures: 66
- task escalations: 0
- verifier passes: 0
- verifier fails: 70
- CLI accepts: 0
- total worker tokens: 444,937
- worker tokens per task pass: 31,781

## Pass Matrix

`PASS` means the archived TBench task validator passed. It does not mean the internal verifier accepted the run.

| Task | RNJ 8B | GPT-OSS 120B | GLM 5.1 | DeepSeek V4 Flash |
|------|--------|--------------|---------|-------------------|
| `hello-world` | PASS | PASS | PASS | PASS |
| `csv-to-parquet` | PASS | PASS | PASS | PASS |
| `broken-python` | fail | fail | PASS | fail |
| `fibonacci-server` | fail | fail | fail | fail |
| `heterogeneous-dates` | fail | fail | PASS | PASS |
| `analyze-access-logs` | fail | fail | fail | fail |
| `bank-trans-filter` | fail | fail | fail | fail |
| `fix-pandas-version` | fail | fail | fail | fail |
| `filter-js-from-html` | fail | fail | fail | fail |
| `break-filter-js-from-html` | fail | fail | fail | fail |
| `count-dataset-tokens` | fail | fail | fail | fail |
| `deterministic-tarball` | fail | fail | fail | fail |
| `extract-safely` | fail | fail | fail | fail |
| `financial-document-processor` | fail | fail | fail | fail |
| `form-filling` | fail | fail | fail | fail |
| `fix-code-vulnerability` | fail | fail | fail | fail |
| `fix-git` | fail | fail | fail | fail |
| `git-leak-recovery` | fail | fail | fail | fail |
| `html-finance-verify` | fail | fail | fail | fail |
| `simple-web-scraper` | PASS | fail | PASS | PASS |

## What This Says

This is not a leaderboard. It is worker-discovery evidence for routing memory.

The useful signal is task-family shape:

- `hello-world` and `csv-to-parquet` are easy delegation targets under the plugin loop. Every worker passed.
- `simple-web-scraper` separates worker fit: RNJ, GLM, and DeepSeek passed; GPT-OSS did not.
- `broken-python` and `heterogeneous-dates` favor the larger reasoning workers in this run.
- Many tasks failed across all workers, which marks them as decomposition candidates, verifier-policy issues, or genuinely hard task families.

The cost signal is also useful:

- RNJ passed fewer tasks than GLM and DeepSeek, but did so with much lower total token spend.
- GPT-OSS 120B passed only the two easiest tasks and spent almost twice RNJ's tokens.
- GLM 5.1 had the highest pass count but also a long duration and high token spend.
- DeepSeek V4 Flash sat between GLM and RNJ on pass count and cost.

That supports the Brain & Brawn framing without overclaiming:

> The brain decomposes and routes. The brawn emits bounded artifacts. The verifier and task validator turn output into cheap state.

It does **not** prove small models beat frontier models. It shows that constrained workers have different useful regions, and those regions are measurable without asking a model to judge itself.

## Server / Cloud Issues

Some rows hit cloud timeout behavior:

| Worker | Task | Symptom |
|--------|------|---------|
| `glm-5.1:cloud` | `filter-js-from-html` | request timed out after 120000ms |
| `glm-5.1:cloud` | `count-dataset-tokens` | request timed out after 120000ms |
| `glm-5.1:cloud` | `deterministic-tarball` | request timed out after 120000ms |
| `glm-5.1:cloud` | `financial-document-processor` | request timed out after 120000ms |
| `glm-5.1:cloud` | `form-filling` | request timed out after 120000ms |
| `glm-5.1:cloud` | `fix-code-vulnerability` | request timed out after 120000ms |
| `deepseek-v4-flash:cloud` | `break-filter-js-from-html` | request timed out after 120000ms |
| `deepseek-v4-flash:cloud` | `count-dataset-tokens` | request timed out after 120000ms |
| `deepseek-v4-flash:cloud` | `form-filling` | request timed out after 120000ms |
| `deepseek-v4-flash:cloud` | `fix-code-vulnerability` | request timed out after 120000ms |

The report still contains validator results for those cells, but the internal `finalAction` / `verifierOverall` fields are `unknown` for several timeout rows. Treat these as cloud-reliability noise when comparing workers.

## Truth Model Notes

The important distinction held:

- `taskValidation.status: "pass"` means the archived TBench validator passed.
- `taskPass: true` is derived from `taskValidation.status === "pass"`.
- `finalAction: "escalate"` does not mean task failure.
- `verifierOverall: "fail"` does not mean task failure.

In this run, all passing cells still had `finalAction: "escalate"` and `verifierOverall: "fail"`. That is the clearest next engineering target: wire the benchmark runner through the native `run --validator` path so external validator success becomes `finalVerdict: "pass"` and `sourceOfTruth: "task-validator"` inside the runtime, not only in post-hoc reporting.

## Next Step

Use this run as discovery data, not final v1 proof.

The next benchmark should run fewer tasks through the native validator path:

```text
55ndeep run "<task prompt>" --validator "<archived task validator command>" --json
```

The target evidence shape is:

- `finalVerdict: "pass" | "fail" | "error"`
- `sourceOfTruth: "task-validator"`
- `taskValidation.status`
- `taskOutcome`
- `taskPass`

That will prove the complete plugin loop end to end.
