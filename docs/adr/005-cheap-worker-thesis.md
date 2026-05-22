# ADR 005: Verification commoditizes model choice

## Status

Accepted

## Date

2026-05-13

## Context

Frontier models produce high-quality code but cost significantly more per token than mid-tier models. The common strategy — have a frontier model self-review or babysit a mid-tier worker — cancels the cost benefit because the frontier model's context consumption dominates the token budget.

The question isn't "can a cheap model beat a frontier model." It's "what fraction of real coding tasks actually require a frontier model to complete correctly?" If the answer is something like 70% / 15% / 15% (routine fixes / import-name errors / genuinely hard problems), and you can route appropriately, you've got a cost-frontier story.

## Decision

Use a **mid-tier cheap model** as the worker that generates code, and run **deterministic verification** (ADR 001) to catch errors. Feed only the **error summary** (compiled by the reducer from emitter signals) back to the worker for targeted correction.

When the correction loop exhausts its budget or hits a problem it can't fix (security finding, broken import graph), it **escalates** — the frontier model takes over for the hard case.

This means:

- The frontier model is reserved for **thinking** (classification, escalation decisions) and the mid-tier model does the **work** (generation, targeted correction)
- The orchestrator never sees the full worker output — only the reduced state packet
- Correction prompts are short and specific (`"Fix 2 lint errors. The orchestrator will re-run ruff."`)
- The system knows when to call the tow truck

## Consequences

### What the data shows

On the 6-worker × 4-task Docker-validated matrix:

| Worker                   | Passes | Tokens/pass | Relative cost |
| ------------------------ | ------ | ----------- | ------------- |
| glm-5-1 (mid-tier)       | 3/4    | 1,650       | 1×            |
| deepseek-v4-flash        | 3/4    | 2,419       | 1.5×          |
| rnj-1:8b                 | 1/4    | 2,744       | 1.7×          |
| qwen3-coder-next         | 1/4    | 4,580       | 2.8×          |
| glm-4-7 (frontier-class) | 2/4    | 5,375       | 3.3×          |

No single model "wins." The pattern is: verification compresses the model-choice axis. Mid-tier models with the verifier gate are competitive on cost-per-validated-pass. Frontier models pay 2-3× the tokens for marginal pass-rate gains.

### Known weakness — the Fiat can't climb mountains

The correction loop is bad at import-name errors (e.g. `PyPDF2` vs `pypdf`). No verifier detects that class of issue. This is the ~15% of tasks where the cheaper worker genuinely needs the frontier model. `finalAction: escalate` is the correct behavior here — a feature, not a verifier-blindness bug. The Fiat knows when to call a tow truck.

### Other limitations

- The cost thesis holds on short tasks (web scraper, data transform). Untested on complex multi-file projects.
- The system ships with FileAdapter for persistent memory (JSON file), not SQLite. Simplifies deps, works for the routing volume this system generates.
- The reducer is fail-closed: if a verifier is missing or errors, the system rejects. You'd rather a CI gate reject a passing diff than accept a broken one.

### The framing

This isn't "cheap model beats frontier." It's **deterministic verification makes the model choice less load-bearing than people assume.** On measured tbench tasks, you can replace a frontier model with a mid-tier model + verification at a token-cost ratio of 2-4× without losing pass rate. The frontier model is still there for the hard cases. It just doesn't need to be there for all of them.

The Fiat reaches the destination. It costs less fuel. Verification keeps it from breaking down on the way. The Ferrari is in the garage — for when you actually need it.
