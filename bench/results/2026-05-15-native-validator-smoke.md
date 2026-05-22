# Native Validator Smoke Report

**Date:** 2026-05-15
**Validator mode:** native
**Tasks:** hello-world, csv-to-parquet, simple-web-scraper
**Workers:** rnj-1:8b-cloud, gpt-oss:120b-cloud

## Purpose

Prove that `BENCH_VALIDATOR_MODE=native` correctly:

- passes `--validator` into 55ndeep run
- populates `finalVerdict` and `sourceOfTruth` from CLI JSON output
- runs the TBench validator inline during the correction loop

## Configuration

| Variable               | Value                      |
| ---------------------- | -------------------------- |
| `BENCH_VALIDATOR_MODE` | native                     |
| `RUN_VALIDATORS`       | 1                          |
| `INCLUDE_SOLO`         | 0                          |
| `TBENCH_DIR`           | (archived Testsuite_tasks) |
| `MAX_CORRECTIONS`      | 2 (default)                |

## Results

| Worker             | Task               | finalAction | finalVerdict | sourceOfTruth      | verifierOverall | taskOutcome | taskPass | Tokens | Turns | Duration |
| ------------------ | ------------------ | ----------- | ------------ | ------------------ | --------------- | ----------- | -------- | ------ | ----- | -------- |
| rnj-1:8b-cloud     | hello-world        | accept      | **pass**     | **task-validator** | fail            | pass        | true     | 1,403  | 3     | 59s      |
| gpt-oss:120b-cloud | hello-world        | accept      | **pass**     | **task-validator** | fail            | pass        | true     | 496    | 1     | 61s      |
| rnj-1:8b-cloud     | csv-to-parquet     | accept      | **pass**     | **task-validator** | fail            | pass        | true     | 285    | 1     | 71s      |
| gpt-oss:120b-cloud | csv-to-parquet     | accept      | **pass**     | **task-validator** | fail            | pass        | true     | 1,623  | 2     | 149s     |
| rnj-1:8b-cloud     | simple-web-scraper | accept      | **pass**     | **task-validator** | fail            | pass        | true     | 946    | 1     | 109s     |
| gpt-oss:120b-cloud | simple-web-scraper | accept      | **pass**     | **task-validator** | fail            | pass        | true     | 6,043  | 3     | 531s     |

## Key Findings

### finalVerdict and sourceOfTruth are present ✅

All 6 rows contain `finalVerdict` and `sourceOfTruth` from the CLI JSON output:

- **finalVerdict**: `"pass"` in every row
- **sourceOfTruth**: `"task-validator"` in every row

### Native validator integration works ✅

The `--validator` flag was correctly passed to 55ndeep run. The `taskValidation` object in each row
confirms the internal `__validate-tbench` command was invoked (visible in the `validator` field
as the full shell command), and `taskValidation.status` matches `finalVerdict`.

### verifierOverall vs taskValidation distinction ✅

- `verifierOverall` is `"fail"` for all rows — this reflects the per-turn code verifier (ruff/pyright),
  which is advisory and separate from the task validator.
- `taskOutcome` and `taskPass` are derived from `taskValidation` (the authoritative TBench run-tests.sh
  result), not from the per-turn verifier.

## Summary

| Metric         | rnj-1:8b-cloud | gpt-oss:120b-cloud |
| -------------- | -------------- | ------------------ |
| Task pass      | 3/3            | 3/3                |
| CLI accept     | 3/3            | 3/3                |
| Worker tokens  | 2,634          | 8,162              |
| Tokens/pass    | 878            | 2,721              |
| Total duration | 240s           | 741s               |

**Overall:** 6/6 task-pass, 6/6 cli-accept, 10,796 total worker tokens, 1,799 tokens/pass.

## Conclusion

Native validator mode is functional. The `--validator` path correctly invokes the TBench
docker-based validator during the correction loop, and result rows faithfully include
`finalVerdict`, `sourceOfTruth`, `finalAction`, `verifierOverall`, `taskValidation`,
`taskOutcome`, and `taskPass`.
