#!/usr/bin/env bash
# 55NDeep CI — full release gate
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
TIMEOUT=300

run_step() {
    local label="$1"; shift
    printf "  %-40s " "$label"
    if timeout "$TIMEOUT" "$@" > /tmp/ci-step.log 2>&1; then
        echo -e "${GREEN}PASS${NC}"
        ((++PASS))
    else
        local rc=$?
        echo -e "${RED}FAIL${NC} (exit=$rc)"
        cat /tmp/ci-step.log
        ((++FAIL))
    fi
}

echo ""
echo -e "${YELLOW}=== CI: $(basename "$(pwd)") ===${NC}"

[ ! -d node_modules ] && run_step "install" npm ci --ignore-scripts

run_step "build"       npm run build
run_step "typecheck"   npm run typecheck
run_step "lint"        npm run lint
run_step "test"        npm test
run_step "test:adapter" npm run test:adapter

if command -v trufflehog &>/dev/null; then
    run_step "secrets" trufflehog filesystem --no-update --directory=. --json
else
    echo -e "  ${YELLOW}secrets${NC}               SKIP (trufflehog not installed)"
fi

echo ""
if [ "$FAIL" -gt 0 ]; then
    echo -e "${RED}CI FAILED — $FAIL step(s) failed, $PASS passed${NC}"
    exit 1
else
    echo -e "${GREEN}CI PASSED — $PASS step(s) ok${NC}"
    exit 0
fi
