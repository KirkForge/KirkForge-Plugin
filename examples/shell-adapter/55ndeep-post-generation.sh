#!/usr/bin/env bash
# 55NDeep post-generation shell adapter
#
# Deterministic verification + correction prompt + observation recording.
# No model calls. Requires jq.
#
# Usage:
#   55ndeep-post-generation.sh \
#     --workspace /path/to/project \
#     --task-id t1 \
#     --task-desc "fix auth bug" \
#     --language typescript \
#     --mode hard-prompt \
#     --model gpt-4 \
#     --outcome pass \
#     --memory /path/to/mem.json \
#     [--elapsed-ms 5000]

set -euo pipefail

# --- Check dependencies -------------------------------------------------------
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not found in PATH" >&2
  exit 1
fi

if ! command -v 55ndeep &>/dev/null; then
  echo "Error: 55ndeep CLI is required but not found in PATH" >&2
  exit 1
fi

# --- Parse arguments -----------------------------------------------------------
WORKSPACE=""
TASK_ID=""
TASK_DESC=""
LANGUAGE=""
MODE=""
MODEL=""
OUTCOME=""
MEMORY_PATH=""
ELAPSED_MS="0"

require_value() {
  # $1=flag name, $2=value (may be empty string if missing)
  if [[ -z "${2:-}" || "${2:-}" == --* ]]; then
    echo "Error: $1 requires a value" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)    require_value --workspace "${2:-}"; WORKSPACE="${2:-}"; shift 2 ;;
    --task-id)      require_value --task-id "${2:-}"; TASK_ID="${2:-}"; shift 2 ;;
    --task-desc)    require_value --task-desc "${2:-}"; TASK_DESC="${2:-}"; shift 2 ;;
    --language)     require_value --language "${2:-}"; LANGUAGE="${2:-}"; shift 2 ;;
    --mode)         require_value --mode "${2:-}"; MODE="${2:-}"; shift 2 ;;
    --model)        require_value --model "${2:-}"; MODEL="${2:-}"; shift 2 ;;
    --outcome)      require_value --outcome "${2:-}"; OUTCOME="${2:-}"; shift 2 ;;
    --memory)       require_value --memory "${2:-}"; MEMORY_PATH="${2:-}"; shift 2 ;;
    --elapsed-ms)   require_value --elapsed-ms "${2:-}"; ELAPSED_MS="${2:-}"; shift 2 ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

# --- Validate required arguments -----------------------------------------------
declare -A REQUIRED_ARGS=(
  [workspace]="$WORKSPACE"
  [task-id]="$TASK_ID"
  [task-desc]="$TASK_DESC"
  [language]="$LANGUAGE"
  [mode]="$MODE"
  [model]="$MODEL"
  [outcome]="$OUTCOME"
  [memory]="$MEMORY_PATH"
)

for flag in "${!REQUIRED_ARGS[@]}"; do
  if [[ -z "${REQUIRED_ARGS[$flag]}" ]]; then
    echo "Error: --$flag is required" >&2
    exit 1
  fi
done

# --- Validate outcome ----------------------------------------------------------
case "$OUTCOME" in
  pass|fail|escalate) ;;
  *) echo "Error: --outcome must be one of: pass, fail, escalate" >&2; exit 1 ;;
esac

# --- Step 1: Verify workspace (fail-closed: treat failure as correction) ------
echo "Verifying workspace: $WORKSPACE" >&2

PACKET_FILE=$(mktemp "${TMPDIR:-/tmp}/55ndeep-packet.XXXXXX.json")
trap 'rm -f "$PACKET_FILE"' EXIT

set +e
VERIFY_OUTPUT=$(55ndeep verify-workspace \
  --workspace "$WORKSPACE" \
  --language "$LANGUAGE" \
  --task-id "$TASK_ID" 2>/dev/null)
VERIFY_RC=$?
set -e

if [[ $VERIFY_RC -ne 0 ]]; then
  echo "Verification failed: workspace may not exist or is not verifiable" >&2
  # Emit a correction prompt for verification failure (fail-closed)
  echo "Verification failure — workspace cannot be verified. Please ensure the workspace directory exists and contains valid source files."
else
  echo "$VERIFY_OUTPUT" > "$PACKET_FILE"
  OVERALL=$(echo "$VERIFY_OUTPUT" | jq -r '.verification.overall')
  echo "Verification overall: $OVERALL" >&2

  # --- Step 2: Build correction prompt if needed --------------------------------
  if [[ "$OVERALL" != "pass" ]]; then
    CORRECTION_PROMPT=$(55ndeep prompt \
      --packet "$PACKET_FILE" \
      --language "$LANGUAGE")

    # Output correction prompt to stdout (reserved for host consumption)
    echo "$CORRECTION_PROMPT"
  fi
fi

# --- Step 3: Record observation ------------------------------------------------
# OUTCOME is host-provided (pass/fail/escalate), not derived from the verifier.
# The host decides whether the task actually passed, not the verifier.
55ndeep observe \
  --memory "$MEMORY_PATH" \
  --task-id "$TASK_ID" \
  --description "$TASK_DESC" \
  --language "$LANGUAGE" \
  --mode "$MODE" \
  --model "$MODEL" \
  --outcome "$OUTCOME" \
  --duration-ms "$ELAPSED_MS" >/dev/null 2>&1 || true

echo "Observation recorded: outcome=$OUTCOME" >&2
