#!/usr/bin/env bash
# examples/verify-broken-repo.sh
# End-to-end demo: run KirkForge's verify cycle against a tiny, intentionally
# broken TypeScript project and assert that the overall verdict is "fail".
#
# This script is the runnable counterpart to docs/STABILITY_MATRIX.md and
# the verifier-fail-closed contract: a real environment with `tsc` available
# must surface the three planted bugs as lint/types/security/graph failures
# in the JSON packet.
#
# Usage (from repo root):
#   bash examples/verify-broken-repo.sh
#
# Expected exit code: 0 (the script itself succeeds). The kirkforge verify
# command will report overall=FAIL — that is the desired output.

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$REPO_ROOT/examples/verify-broken-repo"
cd "$FIXTURE_DIR"

echo "=== KirkForge end-to-end demo: broken-repo verification ==="
echo "Fixture: $FIXTURE_DIR"
echo ""

if ! command -v tsc >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
  echo "WARNING: neither tsc nor npx is available. The TypeScript slot will"
  echo "         report status:error (verifier missing binary). That is the"
  echo "         expected fail-closed behavior. The lint and graph slots"
  echo "         should still surface the planted bugs."
fi

echo "--- Running kirkforge verify ---"
echo ""

# Invoke the CLI in JSON mode so the verdict is machine-parseable.
# Use --self-verify-style invocation: the orchestrator's verify() method
# reads verifierPolicy from detectTaskProfile, which for TypeScript puts
# lint, types, security in `required` and graph in `advisory`. With three
# real defects, types and security will fail; lint will also flag eval.
# Graph is advisory but will still surface a broken edge.
#
# The CLI's `verify` command auto-discovers files from the current cwd;
# we cd into the fixture so the broken bugs.ts is in scope.
set +e
OUTPUT=$(npx --prefix "$REPO_ROOT" tsx "$REPO_ROOT/apps/cli/src/index.ts" verify \
  --task "verify the broken-repo fixture" \
  --json 2>&1)
RC=$?
set -e

echo "$OUTPUT" | head -200
echo ""

if [ $RC -ne 0 ]; then
  echo "Note: kirkforge verify exited $RC. With three planted defects, a"
  echo "non-zero exit is the correct outcome for a TypeScript profile"
  echo "(types=required, security=required)."
fi

# Parse the overall verdict and assert it is "fail" or "warn".
OVERALL=$(echo "$OUTPUT" | grep -oE '"overall"\s*:\s*"(pass|fail|warn)"' | head -1 | grep -oE '"(pass|fail|warn)"' | tr -d '"' || true)

if [ "$OVERALL" = "fail" ] || [ "$OVERALL" = "warn" ]; then
  echo ""
  echo "=== PASS: verifier surfaced the planted defects (overall=$OVERALL) ==="
  exit 0
fi

echo ""
echo "=== UNEXPECTED: overall=$OVERALL (expected fail or warn) ==="
echo "The fixture's three defects should produce a non-pass verdict."
echo "If overall=pass, the verifier is fail-open — that is a regression."
exit 1
