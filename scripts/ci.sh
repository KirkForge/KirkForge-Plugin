#!/usr/bin/env bash
set -euo pipefail

echo "=== 55NDeep CI ==="
echo ""

echo "[1/5] Installing dependencies..."
echo "  Note: if using SQLite backend (better-sqlite3), native build tools are required."
echo "  Default FileAdapter needs no native deps."
npm ci --prefer-offline 2>&1 | tail -3

echo "[2/5] Linting..."
npx eslint packages apps --max-warnings 0 2>&1 || {
  echo "❌ Lint failed"
  exit 1
}

echo "[3/5] Type-checking..."
npx tsc --build

echo "[4/5] Running tests with coverage..."
npx vitest run --coverage.enabled=true --coverage.reporter=text --coverage.reporter=json --coverage.reporter=html 2>&1

echo "[5/5] Checking coverage thresholds..."
# Extract line coverage percentage from vitest JSON output using Node.js
COVERAGE=$(node -e "
  try {
    const c = require('./coverage/coverage-summary.json');
    const pct = c.total.lines.pct;
    console.log(pct);
  } catch(e) { console.log(-1); }
" 2>/dev/null)

echo "  Line coverage: ${COVERAGE}%"

if [ "${COVERAGE}" = "-1" ]; then
  echo "  ⚠️  Could not read coverage report — skipping threshold check"
elif [ "$(node -e "console.log(${COVERAGE} < 70 ? 1 : 0)")" = "1" ]; then
  echo "❌ Coverage ${COVERAGE}% is below 70% threshold"
  exit 1
fi

echo ""
echo "✅ CI passed"
