#!/usr/bin/env bash
# Minimal local validator example.
# Not a benchmark claim. Demonstrates verifier + local task validator flow.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Step 1: Verify workspace (deterministic) ==="
kirkforge verify-workspace --workspace "$SCRIPT_DIR" --language python

echo ""
echo "=== Step 2: Run local task validator (pytest) ==="
if python3 -m pytest "$SCRIPT_DIR/tests/" -v --tb=short 2>&1; then
  OUTCOME="pass"
else
  OUTCOME="fail"
fi

echo ""
echo "=== Step 3: Record observation (host-provided outcome) ==="
echo "Task outcome: $OUTCOME"
echo "Run: kirkforge observe --memory /tmp/validator-task-mem.json \\"
echo "  --task-id validator-task-example \\"
echo "  --description 'add two numbers' \\"
echo "  --language python --mode artifact --model example \\"
echo "  --outcome $OUTCOME --duration-ms 500"
