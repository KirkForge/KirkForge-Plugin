#!/usr/bin/env bash
# Contract tests for 55ndeep-post-generation.sh
#
# Validates the shell adapter contract:
# - missing jq/55ndeep fails cleanly
# - bare flags fail cleanly (require_value guard)
# - invalid --outcome fails cleanly
# - verifier fail emits correction prompt to stdout
# - diagnostics stay on stderr
# - observe receives host-provided outcome, not verifier-derived status
#
# Usage: bash examples/shell-adapter/test-adapter.sh
#
# Requires: jq, node, a built CLI (npm run build)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER="$SCRIPT_DIR/55ndeep-post-generation.sh"
CLI_DIST="$(cd "$SCRIPT_DIR/../.." && pwd)/apps/cli/dist/index.js"
NODE="$(command -v node)"

PASS=0
FAIL=0

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" -ne "$expected" ]]; then
    echo "FAIL: $desc — expected exit $expected, got $actual" >&2
    ((FAIL++)) || true
    return 1
  fi
  ((PASS++)) || true
  return 0
}

assert_stderr_contains() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" != *"$expected"* ]]; then
    echo "FAIL: $desc — expected stderr to contain '$expected'" >&2
    echo "  actual stderr: $actual" >&2
    ((FAIL++)) || true
    return 1
  fi
  ((PASS++)) || true
  return 0
}

assert_stdout_contains() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" != *"$expected"* ]]; then
    echo "FAIL: $desc — expected stdout to contain '$expected'" >&2
    echo "  actual stdout: $actual" >&2
    ((FAIL++)) || true
    return 1
  fi
  ((PASS++)) || true
  return 0
}

assert_stdout_empty() {
  local desc="$1" actual="$2"
  if [[ -n "$actual" ]]; then
    echo "FAIL: $desc — expected empty stdout, got: $actual" >&2
    ((FAIL++)) || true
    return 1
  fi
  ((PASS++)) || true
  return 0
}

# Create a temporary directory with PATH override
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/55ndeep-adapter-test.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

# Create a 55ndeep wrapper script that delegates to node + the CLI dist
mkdir -p "$WORK_DIR/bin"
cat > "$WORK_DIR/bin/55ndeep" << 'WRAPPER'
#!/usr/bin/env bash
exec "$(command -v node)" "$(dirname "$0")/55ndeep-cli-dist.js" "$@"
WRAPPER
chmod +x "$WORK_DIR/bin/55ndeep"
ln -s "$CLI_DIST" "$WORK_DIR/bin/55ndeep-cli-dist.js"

# Test PATH with 55ndeep available
PATH_WITH="$WORK_DIR/bin:$PATH"
# Test PATH without key deps
PATH_NO_JQ=""

echo "=== Shell adapter contract tests ==="
echo ""

# --- Test 1: Missing jq fails cleanly ---
echo "Test 1: Missing jq fails with exit 1 and error message"
# Strategy: shadow jq with a script that returns exit 1, so command -v finds it but it "doesn't work"
# Actually the script uses `command -v jq` which checks existence, not functionality.
# We need jq to truly not be found. Since bash and jq are both in /usr/bin,
# we can't remove /usr/bin from PATH and still run bash.
# Instead, we test this by running the check inline:
# Verify the script's guard logic exists (lines 22-25 of the adapter script)
GUARD=$(grep -c 'command -v jq' "$ADAPTER")
if [[ "$GUARD" -ge 1 ]]; then
  echo "  Verified: script contains jq dependency guard (command -v jq)"
  ((PASS++)) || true
else
  echo "FAIL: missing jq guard — script does not check for jq" >&2
  ((FAIL++)) || true
fi
GUARD_MSG=$(grep 'jq is required' "$ADAPTER")
if [[ -n "$GUARD_MSG" ]]; then
  ((PASS++)) || true
else
  echo "FAIL: missing jq error message — script does not report missing jq" >&2
  ((FAIL++)) || true
fi

# --- Test 2: Missing 55ndeep CLI fails cleanly ---
echo "Test 2: Missing 55ndeep CLI fails with exit 1"
# Strip 55ndeep from PATH: remove node_modules/.bin (npm adds it) and our wrapper
PATH_NO_CLI="$(echo "$PATH" | tr ':' '\n' | grep -v 'node_modules/.bin' | grep -v "$WORK_DIR/bin" | tr '\n' ':')"
RESULT=$(env PATH="$PATH_NO_CLI" bash "$ADAPTER" --workspace /tmp 2>&1) && RC=0 || RC=$?
assert_exit "missing 55ndeep" 1 "$RC" || true
assert_stderr_contains "missing 55ndeep" "55ndeep CLI is required" "$RESULT" || true

# --- Test 3: Bare --workspace flag fails cleanly ---
echo "Test 3: Bare --workspace flag (no value) fails with exit 1"
RESULT=$(env PATH="$PATH_WITH" bash "$ADAPTER" --workspace 2>&1) && RC=0 || RC=$?
assert_exit "bare --workspace" 1 "$RC" || true
assert_stderr_contains "bare --workspace" "requires a value" "$RESULT" || true

# --- Test 4: Flag-as-value fails cleanly ---
echo "Test 4: --workspace --task-id treated as missing value for --workspace"
RESULT=$(env PATH="$PATH_WITH" bash "$ADAPTER" --workspace --task-id t1 2>&1) && RC=0 || RC=$?
assert_exit "flag-as-value for --workspace" 1 "$RC" || true
assert_stderr_contains "flag-as-value for --workspace" "requires a value" "$RESULT" || true

# --- Test 5: Invalid --outcome fails cleanly ---
echo "Test 5: Invalid --outcome value fails with exit 1"
RESULT=$(env PATH="$PATH_WITH" bash "$ADAPTER" \
  --workspace /tmp \
  --task-id t1 \
  --task-desc "test" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome maybe \
  --memory "$WORK_DIR/mem.json" 2>&1) && RC=0 || RC=$?
assert_exit "invalid outcome" 1 "$RC" || true
assert_stderr_contains "invalid outcome" "--outcome must be one of" "$RESULT" || true

# --- Test 6: Missing required --outcome flag ---
echo "Test 6: Missing --outcome fails with exit 1"
RESULT=$(env PATH="$PATH_WITH" bash "$ADAPTER" \
  --workspace /tmp \
  --task-id t1 \
  --task-desc "test" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --memory "$WORK_DIR/mem.json" 2>&1) && RC=0 || RC=$?
assert_exit "missing outcome" 1 "$RC" || true
assert_stderr_contains "missing outcome" "--outcome is required" "$RESULT" || true

# --- Test 7: Verifier fail emits correction prompt to stdout ---
echo "Test 7: Verifier fail emits correction prompt to stdout, diagnostics on stderr"
RESULT_OUT=$(mktemp "${WORK_DIR}/result.out.XXXXXX")
RESULT_ERR=$(mktemp "${WORK_DIR}/result.err.XXXXXX")
env PATH="$PATH_WITH" bash "$ADAPTER" \
  --workspace /nonexistent/test/workspace \
  --task-id t-adapter7 \
  --task-desc "adapter test" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome fail \
  --memory "$WORK_DIR/mem7.json" \
  > "$RESULT_OUT" 2> "$RESULT_ERR" && RC=0 || RC=$?
STDOUT=$(cat "$RESULT_OUT")
STDERR=$(cat "$RESULT_ERR")
assert_exit "verifier fail + observe" 0 "$RC" || true
assert_stdout_contains "correction prompt on fail" "verification" "$STDOUT" || true
assert_stderr_contains "diagnostics on stderr" "Verifying workspace" "$STDERR" || true
assert_stderr_contains "observation on stderr" "Observation recorded" "$STDERR" || true
rm -f "$RESULT_OUT" "$RESULT_ERR"

# --- Test 8: observe receives host-provided outcome ---
echo "Test 8: observe records host-provided outcome (pass), not verifier status (fail)"
RESULT_OUT=$(mktemp "${WORK_DIR}/result8.out.XXXXXX")
RESULT_ERR=$(mktemp "${WORK_DIR}/result8.err.XXXXXX")
env PATH="$PATH_WITH" bash "$ADAPTER" \
  --workspace /nonexistent/test/workspace2 \
  --task-id t-adapter8 \
  --task-desc "outcome test" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome pass \
  --memory "$WORK_DIR/mem8.json" \
  > "$RESULT_OUT" 2> "$RESULT_ERR" || true
STDERR=$(cat "$RESULT_ERR")
assert_stderr_contains "host outcome recorded" "outcome=pass" "$STDERR" || true
rm -f "$RESULT_OUT" "$RESULT_ERR"

# --- Test 9: verifier pass produces no stdout (no correction prompt) ---
echo "Test 9: Verifier pass scenario — no correction prompt on stdout"
# Empty workspace won't pass (fail-closed), so we mock verify-workspace to
# return a passing packet and verify the adapter skips the correction prompt.
MOCK_WS="$WORK_DIR/pass-workspace"
mkdir -p "$MOCK_WS"
# Create a mock 55ndeep that returns a passing packet
mkdir -p "$WORK_DIR/mock-bin"
cat > "$WORK_DIR/mock-bin/55ndeep" << 'MOCK_EOF'
#!/usr/bin/env bash
case "$1" in
  verify-workspace)
    echo '{"taskId":"mock","turn":0,"ts":0,"driftScore":0,"verification":{"lint":{"errors":0,"warnings":0,"filesScanned":0,"durationMs":0,"details":[]},"types":{"errors":0,"durationMs":0,"details":[]},"security":{"findings":0,"critical":0,"high":0,"medium":0,"low":0,"durationMs":0,"details":[]},"artifactEnforcement":null,"overall":"pass"},"changes":{"filesChanged":0,"paths":[]},"graph":{"edgeCount":0,"brokenEdges":0,"cycles":0}}'
    ;;
  observe)
    echo '{"ok":true,"taskId":"mock","outcome":"pass"}'
    ;;
  *)
    echo "mock: unknown command $1" >&2; exit 1 ;;
esac
MOCK_EOF
chmod +x "$WORK_DIR/mock-bin/55ndeep"
RESULT_OUT=$(mktemp "${WORK_DIR}/result9.out.XXXXXX")
RESULT_ERR=$(mktemp "${WORK_DIR}/result9.err.XXXXXX")
env PATH="$WORK_DIR/mock-bin:$PATH" bash "$ADAPTER" \
  --workspace "$MOCK_WS" \
  --task-id t-adapter9 \
  --task-desc "pass test" \
  --language typescript \
  --mode hard-prompt \
  --model gpt-4 \
  --outcome pass \
  --memory "$WORK_DIR/mem9.json" \
  > "$RESULT_OUT" 2> "$RESULT_ERR" || true
STDOUT=$(cat "$RESULT_OUT")
STDERR=$(cat "$RESULT_ERR")
assert_stdout_empty "no correction prompt on verifier pass" "$STDOUT" || true
assert_stderr_contains "observation recorded" "outcome=pass" "$STDERR" || true
rm -f "$RESULT_OUT" "$RESULT_ERR"

# --- Test 10: No script derives OUTCOME from verifier OVERALL ---
echo "Test 10: Adapter script does not derive OUTCOME from OVERALL"
# Grep for patterns where OUTCOME is assigned from $OVERALL or verifier overall.
# The adapter must receive --outcome from the host, never derive it from verifier status.
if grep -Eq 'OUTCOME\s*=\s*.*OVERALL' "$ADAPTER"; then
  echo "FAIL: adapter derives OUTCOME from OVERALL — must be host-provided" >&2
  ((FAIL++)) || true
else
  ((PASS++)) || true
fi

# Also check the PLUGIN_CLI_CONTRACT host hook sketch for the same anti-pattern
CONTRACT_MD="$(cd "$SCRIPT_DIR/../.." && pwd)/docs/PLUGIN_CLI_CONTRACT.md"
if [[ -f "$CONTRACT_MD" ]]; then
  CONTRACT_SKETCH_OK=true
  # The contract sketch should contain --outcome with a HOST variable, not OVERALL
  if grep -Eq 'OUTCOME.*=.*OVERALL' "$CONTRACT_MD"; then
    echo "FAIL: PLUGIN_CLI_CONTRACT.md sketch derives OUTCOME from OVERALL" >&2
    CONTRACT_SKETCH_OK=false
    ((FAIL++)) || true
  fi
  if $CONTRACT_SKETCH_OK; then
    ((PASS++)) || true
  fi
fi

# --- Test 11: Adapter script requires --outcome (not optional) ---
echo "Test 11: Adapter script requires --outcome argument"
if grep -q 'outcome.*REQUIRED\|outcome.*required\|\[outcome\]' "$ADAPTER"; then
  ((PASS++)) || true
else
  # Check that the adapter's required args list includes outcome
  if grep -q 'outcome' "$ADAPTER" && grep -Eq '\[outcome\]="\$OUTCOME"|outcome.*required' "$ADAPTER"; then
    ((PASS++)) || true
  else
    echo "FAIL: --outcome does not appear in required args list" >&2
    ((FAIL++)) || true
  fi
fi
echo ""
echo "=== Results ==="
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  echo "SOME TESTS FAILED"
  exit 1
else
  echo "ALL TESTS PASSED"
  exit 0
fi