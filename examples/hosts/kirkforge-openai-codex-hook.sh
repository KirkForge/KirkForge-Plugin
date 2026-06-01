#!/usr/bin/env bash
# kirkforge-openai-codex-hook.sh
#
# Example: post-generation hook for OpenAI Codex CLI.
# NOT an installed plugin. This is a contract-conforming sketch.
#
# Codex writes files, then calls this script.
# The script verifies, builds a correction prompt if needed, and records
# the host-provided task outcome. Codex decides whether the task passed.
#
# Usage:
#   kirkforge-openai-codex-hook.sh \
#     --workspace /path/to/project \
#     --task-id t1 \
#     --task-desc "implement user auth" \
#     --language typescript \
#     --model codex-1 \
#     --outcome pass \
#     --memory ./kirkforge-memory.json \
#     [--elapsed-ms 10000]
#
# In Codex's config (codex.yaml or equivalent):
#   hooks:
#     postGeneration: kirkforge-openai-codex-hook.sh --workspace $WORKSPACE ...

set -euo pipefail

WORKSPACE=""
TASK_ID=""
TASK_DESC=""
LANGUAGE="typescript"
MODEL="codex-1"
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
PACKET=$(kirkforge verify-workspace --workspace "$WORKSPACE" --language "$LANGUAGE" --task-id "$TASK_ID")
OVERALL=$(echo "$PACKET" | jq -r '.verification.overall')

echo "[kirkforge] verification: $OVERALL" >&2

# Step 2: If verification failed, emit correction prompt to stdout
# Codex reads stdout and injects the prompt into its next model turn.
if [[ "$OVERALL" != "pass" ]]; then
  PACKET_FILE=$(mktemp "${TMPDIR:-/tmp}/kirkforge-packet.XXXXXX.json")
  echo "$PACKET" > "$PACKET_FILE"
  trap 'rm -f "$PACKET_FILE"' EXIT

  CORRECTION=$(kirkforge prompt --packet "$PACKET_FILE" --language "$LANGUAGE")
  echo "$CORRECTION"
fi

# Step 3: Record task outcome (host-provided, not verifier-derived)
kirkforge observe \
  --memory "$MEMORY_PATH" \
  --task-id "$TASK_ID" \
  --description "$TASK_DESC" \
  --language "$LANGUAGE" \
  --mode hard-prompt \
  --model "$MODEL" \
  --outcome "$OUTCOME" \
  --duration-ms "$ELAPSED_MS" >/dev/null

echo "[kirkforge] observation recorded: outcome=$OUTCOME" >&2