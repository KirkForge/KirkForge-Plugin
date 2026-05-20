#!/usr/bin/env bash
# run-225-native-worker.sh — Overnight native benchmark runner for .225 worker
#
# Usage:
#   WORKERS=rnj-1:8b-cloud,gpt-oss:120b-cloud ./scripts/run-225-native-worker.sh
#
# Environment variables:
#   WORKERS        (required) comma-separated Ollama model names
#   TBENCH_DIR     task corpus directory (default: $HOME/Madlab/archeived/Harness_research/55NDeep/Testsuite_tasks when present)
#   TASKS          comma-separated task names (default: built-in list)
#   MAX_CORRECTIONS correction turns per worker (default: 2)
#   VALIDATOR_BACKEND docker | local | auto (default: docker)
#   INCLUDE_SOLO   0 disables solo baseline (default: 0)
#   RUN_VALIDATORS 1 enables validators (default: 1)
#   ALLOW_MISSING_VERIFIERS 1 skips verifier preflight (default: 1)
#   KEEP_RUNS      1 preserves temp run dirs (default: 0)

set -euo pipefail

# ── Source nvm and select Node 22 if available ──────────────────────────────
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$NVM_DIR/nvm.sh"
  nvm use 22 >/dev/null 2>&1 || true
fi

# ── Required: WORKERS ───────────────────────────────────────────────────────
if [[ -z "${WORKERS:-}" ]]; then
  echo "ERROR: WORKERS env var is required." >&2
  echo "Example: WORKERS=rnj-1:8b-cloud,gpt-oss:120b-cloud ./scripts/run-225-native-worker.sh" >&2
  exit 1
fi

# ── Default TBENCH_DIR ─────────────────────────────────────────────────────
DEFAULT_TBENCH_DIR="$HOME/Madlab/archeived/Harness_research/55NDeep/Testsuite_tasks"
if [[ -z "${TBENCH_DIR:-}" ]]; then
  if [[ -d "$DEFAULT_TBENCH_DIR" ]]; then
    TBENCH_DIR="$DEFAULT_TBENCH_DIR"
  else
    echo "ERROR: TBENCH_DIR is unset and default $DEFAULT_TBENCH_DIR does not exist." >&2
    exit 1
  fi
fi
export TBENCH_DIR

# ── Script directory (repo root) ───────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Benchmark configuration ────────────────────────────────────────────────
export BENCH_VALIDATOR_MODE="native"
export RUN_VALIDATORS="${RUN_VALIDATORS:-1}"
export VALIDATOR_BACKEND="${VALIDATOR_BACKEND:-docker}"
export INCLUDE_SOLO="${INCLUDE_SOLO:-0}"
export MAX_CORRECTIONS="${MAX_CORRECTIONS:-2}"
export ALLOW_MISSING_VERIFIERS="${ALLOW_MISSING_VERIFIERS:-1}"
export KEEP_RUNS="${KEEP_RUNS:-0}"

USE_SG_DOCKER=false
if [[ "$VALIDATOR_BACKEND" == "docker" ]] && ! groups 2>/dev/null | grep -qw docker; then
  if sg docker -c "true" 2>/dev/null; then
    USE_SG_DOCKER=true
  else
    echo "WARNING: Docker group not active and 'sg docker' not available." >&2
    echo "         Falling back to VALIDATOR_BACKEND=local" >&2
    export VALIDATOR_BACKEND="local"
  fi
fi

# ── Print config ────────────────────────────────────────────────────────────
echo "=== .225 Native Worker Benchmark ==="
echo "  TBENCH_DIR:           $TBENCH_DIR"
echo "  WORKERS:              $WORKERS"
echo "  TASKS:                ${TASKS:-<default list>}"
echo "  MAX_CORRECTIONS:      $MAX_CORRECTIONS"
echo "  BENCH_VALIDATOR_MODE: $BENCH_VALIDATOR_MODE"
echo "  VALIDATOR_BACKEND:    $VALIDATOR_BACKEND"
echo "  RUN_VALIDATORS:        $RUN_VALIDATORS"
echo "  INCLUDE_SOLO:         $INCLUDE_SOLO"
echo "  ALLOW_MISSING_VERIFIERS: $ALLOW_MISSING_VERIFIERS"
echo "  KEEP_RUNS:            $KEEP_RUNS"
echo "  Node:                 $(node --version)"
echo "  Repo:                 $SCRIPT_DIR"
echo "  Docker wrapper:       $([[ "$USE_SG_DOCKER" == "true" ]] && echo "sg docker" || echo "direct")"
echo "=================================="

# ── Run ─────────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"
if [[ "$USE_SG_DOCKER" == "true" ]]; then
  exec sg docker -c "cd '$SCRIPT_DIR' && node bench/real-tbench-benchmark.mjs"
fi
exec node bench/real-tbench-benchmark.mjs
