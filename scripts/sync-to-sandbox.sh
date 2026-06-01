#!/usr/bin/env bash
# sync-to-sandbox.sh — Copy tracked files from publish repo to sandbox
#
# Usage:
#   ./scripts/sync-to-sandbox.sh           # copy files
#   ./scripts/sync-to-sandbox.sh --dry-run  # preview only
#
# Copies source, docs, and bench scripts from the publish repo
# to the sandbox. Never touches sandbox .env, node_modules,
# benchmark reports, or runtime state.

set -euo pipefail

PUBLISH_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SANDBOX_ROOT="${SANDBOX_ROOT:-$HOME/Madlab/sandbox/kirkforge}"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ ! -d "$SANDBOX_ROOT" ]]; then
  echo "ERROR: Sandbox directory does not exist: $SANDBOX_ROOT" >&2
  echo "Set SANDBOX_ROOT to override." >&2
  exit 1
fi

# Directories and files to sync (relative to publish root)
SYNC_PATHS=(
  scripts/create-publish-zip.sh
  packages
  apps
  docs
  examples
  scripts
  bench/README.md
  bench/REAL_TBENCH_GUIDE.md
  bench/results
  package.json
  package-lock.json
  tsconfig.json
  vitest.config.ts
  eslint.config.js
  changelog.md
  REPORULES.md
)

# Excluded patterns — never copy these even if they exist in publish repo
RSYNC_EXCLUDES=(
  --exclude='node_modules'
  --exclude='.git'
  --exclude='.env'
  --exclude='dist'
  --exclude='*.log'
  --exclude='*.tmp'
  --exclude='*.sqlite'
  --exclude='*.sqlite3'
  --exclude='*.db'
  --exclude='*.pem'
  --exclude='*.key'
  --exclude='*.tsbuildinfo'
  --exclude='report-real-*.json'
)

echo "=== Sync: $PUBLISH_ROOT -> $SANDBOX_ROOT ==="
echo ""

COPIED=0
SKIPPED=0

for rel_path in "${SYNC_PATHS[@]}"; do
  src="$PUBLISH_ROOT/$rel_path"
  dst="$SANDBOX_ROOT/$rel_path"

  if [[ ! -e "$src" ]]; then
    echo "  SKIP: $rel_path (does not exist in publish repo)"
    ((SKIPPED++)) || true
    continue
  fi

  if [[ -d "$src" ]]; then
    if $DRY_RUN; then
      echo "  WOULD COPY: $rel_path/ (directory)"
      rsync -av --dry-run "${RSYNC_EXCLUDES[@]}" "$src/" "$dst/" 2>/dev/null || true
    else
      echo "  COPYING: $rel_path/ -> $dst"
      rsync -av "${RSYNC_EXCLUDES[@]}" "$src/" "$dst/"
    fi
    ((COPIED++)) || true
  else
    if $DRY_RUN; then
      echo "  WOULD COPY: $rel_path"
    else
      mkdir -p "$(dirname "$dst")"
      cp "$src" "$dst"
      echo "  COPIED: $rel_path"
    fi
    ((COPIED++)) || true
  fi
done

# Preserve sandbox .env
if [[ -f "$SANDBOX_ROOT/.env" ]]; then
  echo ""
  echo "  PRESERVED: sandbox .env (not overwritten)"
fi

echo ""
if $DRY_RUN; then
  echo "=== DRY RUN COMPLETE ==="
  echo "  ${COPIED} paths would be synced"
  echo "  ${SKIPPED} paths skipped (not in publish repo)"
else
  echo "=== SYNC COMPLETE ==="
  echo "  ${COPIED} paths synced"
  echo "  ${SKIPPED} paths skipped (not in publish repo)"
fi
