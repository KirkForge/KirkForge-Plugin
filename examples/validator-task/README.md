# Minimal Local Validator Task Example

This is a deterministic local validator example. It is **not a benchmark claim**. It demonstrates how a host CLI can use KirkForge's verifier battery and a local test runner to produce `taskPass: true` / `taskPass: false` evidence.

## What it is

A tiny Python project with two files:

- `solution.py` — a function that adds two numbers
- `tests/test_solution.py` — a pytest test that imports and asserts on it

The validator runs `ruff check` (lint) and `pyright` (types) via KirkForge, then runs `pytest` as a local task validator.

## What it is not

- Not a model-quality benchmark
- Not a claim that small models beat frontier models
- Not representative of real-world task complexity

## Files

```
examples/validator-task/
  solution.py          # Candidate code: def add(a, b): return a + b
  tests/
    test_solution.py   # pytest: assert add(2, 3) == 5
  run-validator.sh     # Run kirkforge verify-workspace + local pytest
  README.md            # This file
```

## Usage

```bash
# 1. Verify workspace (deterministic, no model calls)
kirkforge verify-workspace --workspace examples/validator-task --language python

# 2. Run task validator (local pytest)
cd examples/validator-task
python3 -m pytest tests/ -v

# 3. Record observation (host-provided outcome, not verifier-derived)
kirkforge observe --memory /tmp/validator-task-mem.json \
  --task-id validator-task-example \
  --description "add two numbers" \
  --language python \
  --mode artifact \
  --model example \
  --outcome pass \
  --duration-ms 500
```

Expected results:

- `verify-workspace` returns `overall: "pass"` (or `"fail"` if lint/types find issues)
- `pytest` exits 0 (pass) or nonzero (fail)
- `observe --outcome` records the host's judgment, not the verifier verdict
