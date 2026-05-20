# Brain Makes It Simple, Brawn Makes It Cheap

Date: 2026-05-14

Source report: `/tmp/bench-sandbox/report-real-1778742814778.json`

Comparison report: `/tmp/bench-sandbox/report-real-1778734637116.json`

This is a benchmark note from the corrected GPT-OSS rerun. The previous matrix used `gpt-oss:cloud`, which resolved to a missing `gpt-oss` model. That row was an endpoint/model-name failure, not a GPT-OSS quality result. This rerun used `gpt-oss:120b-cloud`.

The claim here is not that small models are generally better than frontier models. That is the wrong frame.

The claim is that deterministic emissions make delegation cheaper. The orchestrator should not spend expensive tokens reading worker prose, guessing whether files were written, or arguing with vague model self-assessments. The worker emits bounded artifacts. Local tools and task validators turn those artifacts into cheap state. The orchestrator routes, retries, or escalates from that state.

Brain makes the work simple. Brawn makes it cheap.

Important caveat: this run happened before PR42's benchmark verifier preflight and before the Python verifier environment was fixed. `ruff`, `pyright`, and `bandit` were missing from PATH at run time. That means these results are valid TBench task-validator evidence, but not a clean full verifier-loop measurement. Missing `ruff` and `pyright` explain why every row still has `finalAction: "escalate"` even when `taskPass: true`.

## Setup

Tasks:

- `simple-web-scraper`
- `csv-to-parquet`
- `broken-python`
- `form-filling`

Workers:

- `rnj-1:8b-cloud`
- `glm-4.7:cloud`
- `glm-5.1:cloud`
- `deepseek-v4-flash:cloud`
- `gpt-oss:120b-cloud`
- `qwen3-coder-next:cloud`

Settings:

- Docker TBench validators
- `INCLUDE_SOLO=0`
- `MAX_CORRECTIONS=3`
- old `gpt-oss:cloud` rows excluded from GPT-OSS scoring

Truth rule:

- `taskPass: true` means the TBench validator passed.
- `finalAction` is not task success.
- `verifierOverall` is internal verifier status, not task truth.

## Headline Result

| Worker | Task Passes | Worker Tokens | Tokens Per Pass | Files |
|---|---:|---:|---:|---:|
| `rnj-1:8b-cloud` | 3/4 | 14,393 | 4,798 | 5 |
| `glm-4.7:cloud` | 3/4 | 61,906 | 20,635 | 12 |
| `qwen3-coder-next:cloud` | 2/4 | 21,256 | 10,628 | 4 |
| `deepseek-v4-flash:cloud` | 2/4 | 32,735 | 16,368 | 5 |
| `glm-5.1:cloud` | 2/4 | 50,143 | 25,072 | 9 |
| `gpt-oss:120b-cloud` | 1/4 | 24,122 | 24,122 | 4 |

RNJ did not prove "8B beats 120B" as a general statement. It proved something more useful: a narrow code/STEM worker can thrive in a constrained artifact environment when the task is decomposed enough and judged by deterministic validators.

## Test Entry 1: simple-web-scraper

| Worker | Result | Tokens | Files | Comment |
|---|---:|---:|---:|---|
| `rnj-1:8b-cloud` | PASS | 4,404 | 1 | Cheap pass. This is the target shape for the harness: one bounded Python artifact, accepted by Docker validation. |
| `glm-4.7:cloud` | PASS | 18,524 | 1 | Passed, but at about 4.2x RNJ's token cost on this task. |
| `glm-5.1:cloud` | PASS | 5,898 | 1 | Strong result. Close to RNJ on this task, still higher cost. |
| `deepseek-v4-flash:cloud` | PASS | 6,813 | 1 | Passed with moderate token cost. |
| `gpt-oss:120b-cloud` | FAIL | 7,671 | 1 | The model ran and emitted a candidate, but TBench rejected it. This is a real candidate failure, not an endpoint failure. |
| `qwen3-coder-next:cloud` | FAIL | 4,684 | 1 | Validator reported an unhealthy service container. Count as failure here, but inspect if this repeats before drawing a model-quality conclusion. |

Comment:

This task supports the narrow-worker thesis. RNJ solved the task at the lowest successful cost. The task is bounded and artifact-friendly, which is exactly where a specialized cheap worker should be useful.

## Test Entry 2: csv-to-parquet

| Worker | Result | Tokens | Files | Comment |
|---|---:|---:|---:|---|
| `rnj-1:8b-cloud` | PASS | 1,663 | 1 | Best result in the run. Small, direct, and cheap. |
| `glm-4.7:cloud` | PASS | 10,053 | 1 | Passed, but used about 6x RNJ's tokens. |
| `glm-5.1:cloud` | PASS | 1,768 | 1 | Excellent cost profile, essentially tied with RNJ. |
| `deepseek-v4-flash:cloud` | PASS | 2,781 | 1 | Passed with low cost. |
| `gpt-oss:120b-cloud` | FAIL | 3,129 | 1 | Candidate failed by looking for `app/data.csv`; likely path/assumption error. |
| `qwen3-coder-next:cloud` | PASS | 1,484 | 1 | Lowest passing token count on this task. |

Comment:

This is the cleanest "deterministic delegation" task in the panel. It has a narrow data transformation goal and a validator that can say yes or no. Cheap and mid-tier workers all do well except GPT-OSS 120B, which made a concrete path assumption error.

## Test Entry 3: broken-python

| Worker | Result | Tokens | Files | Comment |
|---|---:|---:|---:|---|
| `rnj-1:8b-cloud` | PASS | 3,026 | 1 | Swinged from fail in the previous run to pass here. This is the important RNJ result. |
| `glm-4.7:cloud` | PASS | 8,091 | 1 | Stable pass across runs. Reliability anchor for this task. |
| `glm-5.1:cloud` | FAIL | 9,841 | 1 | Regressed from pass to fail. Candidate had `NameError: name 'content' is not defined`. |
| `deepseek-v4-flash:cloud` | FAIL | 7,742 | 1 | Failed with environment/dependency handling around missing pip. |
| `gpt-oss:120b-cloud` | PASS | 4,413 | 1 | This is GPT-OSS 120B's one pass. It did handle the dependency repair task. |
| `qwen3-coder-next:cloud` | PASS | 2,618 | 1 | Swinged from fail to pass. Very efficient when it hits. |

Comment:

This is the swing task. RNJ gained a pass, GLM 5.1 lost one, Qwen gained one, GPT-OSS 120B passed. The task is less deterministic for workers because it requires interpreting a broken environment/dependency setup. This is where repeated runs matter.

## Test Entry 4: form-filling

| Worker | Result | Tokens | Files | Comment |
|---|---:|---:|---:|---|
| `rnj-1:8b-cloud` | FAIL | 5,300 | 2 | Produced files, failed validation. |
| `glm-4.7:cloud` | FAIL | 25,238 | 9 | Spent heavily and still failed. |
| `glm-5.1:cloud` | FAIL | 32,636 | 6 | Spent the most on the task, still failed. |
| `deepseek-v4-flash:cloud` | FAIL | 15,399 | 2 | Failed despite substantial token spend. |
| `gpt-oss:120b-cloud` | FAIL | 8,909 | 1 | Produced a candidate, failed validation. |
| `qwen3-coder-next:cloud` | FAIL | 12,470 | 1 | Produced a candidate, failed validation. |

Comment:

This task is the hard boundary in the panel. Every worker failed. It is useful because it prevents overclaiming. The harness does not make cheap workers magic. It makes failures visible and cheap to classify. For this task, the next orchestrator move should be decomposition: split PDF parsing, field extraction, output schema, and validator expectations into smaller units.

## RNJ 8B vs GPT-OSS 120B

| Metric | `rnj-1:8b-cloud` | `gpt-oss:120b-cloud` |
|---|---:|---:|
| Task passes | 3/4 | 1/4 |
| Worker tokens | 14,393 | 24,122 |
| Tokens per pass | 4,798 | 24,122 |
| Files created | 5 | 4 |
| Passed `simple-web-scraper` | yes | no |
| Passed `csv-to-parquet` | yes | no |
| Passed `broken-python` | yes | yes |
| Passed `form-filling` | no | no |

Comment:

This is the interesting comparison, not because RNJ is "better" in general, but because RNJ is better matched to this role. It is a narrow code/STEM worker operating inside a bounded emission harness. GPT-OSS 120B is larger and broader, but this benchmark does not reward broad assistant behavior. It rewards getting files into the right shape under validator pressure.

## Swing Versus Previous Run

Valid non-GPT rows only:

| Worker | Previous Passes | Corrected Run Passes | Swing |
|---|---:|---:|---:|
| `rnj-1:8b-cloud` | 2 | 3 | +1 |
| `glm-4.7:cloud` | 3 | 3 | 0 |
| `glm-5.1:cloud` | 3 | 2 | -1 |
| `deepseek-v4-flash:cloud` | 2 | 2 | 0 |
| `qwen3-coder-next:cloud` | 2 | 2 | 0 |

The swing is real but contained. The stable signals are:

- `csv-to-parquet` is easy for most workers.
- `form-filling` is hard for all workers.
- `glm-4.7:cloud` is the most stable 3/4 anchor in these two runs.
- RNJ can swing upward on `broken-python`, which suggests the task is inside its capability band but not deterministic for it.

## What This Proves

This supports the orchestration economics claim:

> Deterministic emission contracts can make low-cost workers useful by converting model output into bounded files and cheap validator state.

The orchestrator does not need to read a worker essay to know what happened. It can inspect:

- files written
- language profile
- validator pass/fail
- task pass/fail
- token cost
- failure class

That is the real saving. The expensive reasoning is spent on decomposition and routing, not on babysitting prose.

## What This Does Not Prove

This does not prove:

- RNJ is generally better than GPT-OSS 120B.
- cheap models beat frontier models.
- the full verifier loop is clean yet.
- `finalAction: "escalate"` means task failure.

The missing Python tools matter. These runs should be described as task-validator evidence, not complete verifier-loop evidence. PR42 added a benchmark verifier preflight so future runs should fail early unless required Python tools are available, or explicitly mark the result as task-validator-only.

## Next Run

Before the next publishable full verifier-loop evidence run:

```bash
python3 -m pip install --user ruff bandit
npm install -g pyright
export PATH="$HOME/.local/bin:$PATH"
ruff --version
pyright --version
bandit --version
55ndeep doctor --pretty
```

Then rerun the same panel. The expected improvement is not necessarily higher `taskPass`. The expected improvement is that `finalAction`, required verifier policy, and task validation stop disagreeing for preventable environment reasons.
