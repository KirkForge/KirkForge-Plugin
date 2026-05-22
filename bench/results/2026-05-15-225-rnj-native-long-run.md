# .225 RNJ Native Long Run

**Date:** 2026-05-15
**Label:** native task-validator evidence, single-worker drift check
**Worker:** `rnj-1:8b-cloud`
**Task set:** 18 archived TBench tasks
**Validator mode:** native
**Source of truth:** task validator

## Why This Run Matters

This run was started on the `.225` worker box to keep the main workstation usable while testing a longer native-validator batch. It was stopped after the RNJ row completed because the result swung hard against the earlier smoke/discovery runs.

The important point is not "RNJ is bad." The important point is that the plugin now surfaces a sharper kind of truth:

- the task validator ran for every completed row
- `sourceOfTruth` was `task-validator`
- `taskPass` was authoritative, not inferred from `finalAction` or `verification.overall`
- the run exposed task/profile/artifact obedience failures that the old post-hoc framing could blur

## Summary

| Metric             |    Value |
| ------------------ | -------: |
| Completed cells    |       18 |
| Task pass          |        1 |
| Task fail          |       17 |
| Task skipped/error |        0 |
| CLI accept         |        1 |
| Verifier pass      |        0 |
| Verifier fail/warn |       18 |
| Worker tokens      |   48,744 |
| Tokens/pass        |   48,744 |
| Files created      |       17 |
| Duration           | ~104 min |

The only passing task was `heterogeneous-dates`.

## Result Table

| Task                           | taskPass | finalVerdict | finalAction | Language   | Files                             | Tokens | Notes                                                               |
| ------------------------------ | -------: | ------------ | ----------- | ---------- | --------------------------------- | -----: | ------------------------------------------------------------------- |
| `hello-world`                  |    false | fail         | escalate    | typescript | `output.ts`                       |  1,508 | Task expected `hello.txt`; worker emitted the wrong artifact shape. |
| `csv-to-parquet`               |    false | fail         | escalate    | python     | `solution.py`                     |  1,810 | Validator failed inside pandas/import path.                         |
| `broken-python`                |    false | fail         | escalate    | python     | `solution.py`                     |  2,341 | Test suite failed.                                                  |
| `heterogeneous-dates`          |     true | pass         | accept      | python     | `solution.py`                     |    477 | Only passing cell.                                                  |
| `analyze-access-logs`          |    false | fail         | escalate    | typescript | `output.ts`                       |  3,288 | Misrouted/emitted TS-shaped artifact for a data task.               |
| `bank-trans-filter`            |    false | fail         | escalate    | python     | `solution.py`                     |  2,720 | Expected output file missing or mismatched.                         |
| `fix-pandas-version`           |    false | fail         | escalate    | python     | `requirements.txt`, `solution.py` |  2,215 | Pandas import/runtime failure.                                      |
| `filter-js-from-html`          |    false | fail         | escalate    | python     | none                              |  2,379 | No candidate files emitted.                                         |
| `break-filter-js-from-html`    |    false | fail         | escalate    | python     | none                              |  1,810 | No candidate files emitted.                                         |
| `count-dataset-tokens`         |    false | fail         | escalate    | typescript | `output.ts`                       |  2,727 | Misrouted/emitted TS-shaped artifact.                               |
| `deterministic-tarball`        |    false | fail         | escalate    | typescript | `app/release.sh`, `solution.sh`   |  4,630 | Shell artifacts emitted, but validator failed.                      |
| `extract-safely`               |    false | fail         | escalate    | typescript | none                              |  2,409 | No candidate files emitted.                                         |
| `financial-document-processor` |    false | fail         | escalate    | python     | `solution.py`                     |  4,906 | Pandas/import path failure.                                         |
| `form-filling`                 |    false | fail         | escalate    | python     | `form_filler.py`                  |  4,002 | Script failed validator checks.                                     |
| `fix-code-vulnerability`       |    false | fail         | escalate    | python     | `app/bottle.py`                   |  3,651 | Validator assertion failure.                                        |
| `fix-git`                      |    false | fail         | escalate    | typescript | `output.ts`, `solution.py`        |  2,501 | Mixed artifact shape; validator failed.                             |
| `git-leak-recovery`            |    false | fail         | escalate    | typescript | `output.ts`                       |  3,502 | Misrouted/emitted TS-shaped artifact.                               |
| `html-finance-verify`          |    false | fail         | escalate    | typescript | none                              |  1,868 | No candidate files emitted.                                         |

## What Changed Compared With Earlier Evidence

Earlier archived post-hoc evidence had RNJ passing `hello-world`, `csv-to-parquet`, and `simple-web-scraper`. This native long run had RNJ fail `hello-world` and `csv-to-parquet`, but pass `heterogeneous-dates`, which it had previously failed.

That swing is the finding.

It suggests RNJ is highly sensitive to prompt/task framing and artifact schema pressure in longer native batches. It also shows that simple aggregate pass-rate tables are not enough. The plugin needs to record:

- task family
- detected language
- emitted file names
- artifact policy failures
- validator failure category
- correction-turn count
- model endpoint/cloud status

Without those fields, a 1/18 run looks like "the model failed." With those fields, it becomes a routing-memory signal: avoid RNJ for file-path-sensitive, multi-artifact, git, and data-processing tasks unless the orchestrator decomposes the task more aggressively.

## Failure Shape

The failures cluster into four useful buckets:

| Bucket                       | Examples                                                                                    | Interpretation                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Wrong artifact shape         | `hello-world`, `analyze-access-logs`, `count-dataset-tokens`, `git-leak-recovery`           | Task/profile detection or prompt schema is not forcing the expected output path strongly enough. |
| No candidate files           | `filter-js-from-html`, `break-filter-js-from-html`, `extract-safely`, `html-finance-verify` | Worker output was not usable as artifacts under the emission contract.                           |
| Runtime/dependency failures  | `csv-to-parquet`, `fix-pandas-version`, `financial-document-processor`                      | Candidate artifacts existed, but task environment/runtime checks failed.                         |
| Real test assertion failures | `bank-trans-filter`, `form-filling`, `fix-code-vulnerability`, `fix-git`                    | Validator ran and rejected the candidate behavior.                                               |

## Current Read

This is not a cloud outage and not a missing-validator artifact. It is a real native-validator run with a bad RNJ result.

It also does not invalidate the Brain/Brawn/Verifier thesis. It sharpens it:

> Cheap brawn works only when the brain makes the work simple enough and the verifier makes the artifact contract concrete enough.

RNJ still looks useful for narrow, well-shaped tasks. It does not look reliable as a broad single-worker choice across mixed archived TBench tasks without stronger task decomposition and stricter emission schemas.

## Engineering Follow-Up

This run points to the next hardening work:

1. Improve task-profile detection for data, git, shell, and file-output tasks.
2. Make expected output paths first-class in the emission schema when the task prompt names them.
3. Add artifact-shape failure categories to benchmark summaries.
4. Store emitted file names and failure buckets in routing memory.
5. Rerun the same 18-task panel with GLM 5.1 and DeepSeek V4 Flash before making any model-quality claims.

The immediate decision was correct: stop the long run after the RNJ row, harvest the evidence, and avoid spending the day benchmarking a path that is already showing strong negative signal.
