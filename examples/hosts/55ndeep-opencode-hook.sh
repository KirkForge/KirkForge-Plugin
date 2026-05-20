#!/usr/bin/env bash
# 55ndeep-opencode-hook.sh
#
# Example: post-generation hook for OpenCode.
# NOT an installed plugin. This is a contract-conforming sketch.
#
# OpenCode is a Node-based CLI that can shell out between model turns.
# This script verifies the workspace, emits a correction prompt if needed,
# and records the host-provided task outcome.
#
# Usage:
#   55ndeep-opencode-hook.sh \
#     --workspace /path/to/project \
#     --task-id t1 \
#     --task-desc "add input validation" \
#     --language typescript \
#     --model opencode-model \
#     --outcome fail \
#     --memory ./55ndeep-memory.json \
#     [--elapsed-ms 8000]
#
# Integration in OpenCode config (opencode.yaml):
#   hooks:
#     postGeneration:
#       command: 55ndeep-opencode-hook.sh
#       args:
#         --workspace: "{{workspace}}"
#         --task-id: "{{taskId}}"
#         --task-desc: "{{taskDescription}}"
#         --language: "{{language}}"
#         --model: "{{model}}"
#         --outcome: "{{outcome}}"
#         --memory: ./55ndeep-memory.json
#         --elapsed-ms: "{{elapsedMs}}"

set -euo pipefail

WORKSPACE=""
TASK_ID=""
TASK_DESC=""
LANGUAGE="typescript"
MODEL=""
OUTCOME=""
MEMORY_PATH=""
ELAPSED_MS="0"

require_value() {
  if [[ -z "${2:-}" || "${2:-}" == --* ]]; then
    echo "Error: $1 requires a value" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)  require_value --workspace "${2:-}"; WORKSPACE="${2:-}"; shift 2 ;;
    --task-id)    require_value --task-id "${2:-}"; TASK_ID="${2:-}"; shift 2 ;;
    --task-desc)  require_value --task-desc "${2:-}"; TASK_DESC="${2:-}"; shift 2 ;;
    --language)   require_value --language "${2:-}"; LANGUAGE="${2:-}"; shift 2 ;;
    --model)      require_value --model "${2:-}"; MODEL="${2:-}"; shift 2 ;;
    --outcome)    require_value --outcome "${2:-}"; OUTCOME="${2:-}"; shift 2 ;;
    --memory)     require_value --memory "${2:-}"; MEMORY_PATH="${2:-}"; shift 2 ;;
    --elapsed-ms) require_value --elapsed-ms "${2:-}"; ELAPSED_MS="${2:-}"; shift 2 ;;
    *) echo "Error: unknown argument: $1" >&2; exit 1 ;;
  esac
done

for arg in WORKSPACE TASK_ID TASK_DESC OUTCOME MEMORY_PATH; do
  if [[ -z "${!arg}" ]]; then
    echo "Error: --$(echo "$arg" | tr '[:upper:]' '[:lower:]' | tr '_' '-') is required" >&2
    exit 1
  fi
done

case "$OUTCOME" in
  pass|fail|escalate) ;;
  *) echo "Error: --outcome must be one of: pass, fail, escalate" >&2; exit 1 ;;
esac

# Step 1: Verify workspace
PACKET=$(55ndeep verify-workspace --workspace "$WORKSPACE" --language "$LANGUAGE" --task-id "$TASK_ID")
OVERALL=$(echo "$PACKET" | jq -r '.verification.overall')

echo "[55ndeep] verification: $OVERALL" >&2

# Step 2: If verification failed, emit correction prompt to stdout
# OpenCode reads stdout and appends the prompt to the next user message.
if [[ "$OVERALL" != "pass" ]]; then
  PACKET_FILE=$(mktemp "${TMPDIR:-/tmp}/55ndeep-packet.XXXXXX.json")
  echo "$PACKET" > "$PACKET_FILE"
  trap 'rm -f "$PACKET_FILE"' EXIT

  CORRECTION=$(55ndeep prompt --packet "$PACKET_FILE" --language "$LANGUAGE")
  echo "$CORRECTION"
fi

# Step 3: Record task outcome (host-provided, not verifier-derived)
55ndeep observe \
  --memory "$MEMORY_PATH" \
  --task-id "$TASK_ID" \
  --description "$TASK_DESC" \
  --language "$LANGUAGE" \
  --mode hard-prompt \
  --model "${MODEL:-unknown}" \
  --outcome "$OUTCOME" \
  --duration-ms "$ELAPSED_MS" >/dev/null

echo "[55ndeep] observation recorded: outcome=$OUTCOME" >&2