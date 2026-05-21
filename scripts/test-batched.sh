#!/usr/bin/env bash
V="node node_modules/.bin/vitest"
R="--reporter=dot"
L="/tmp/55n-test.log"
FAIL=0

echo "=== Test Suite ==="

printf "  %-40s " "core"
$V run packages/core-types/tests/result.test.ts packages/core-events/tests/index.test.ts packages/core-logging/tests/index.test.ts packages/core-tenancy/tests/index.test.ts packages/core-secrets/tests/sigv4.test.ts packages/core-telemetry/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "lint-1"
$V run packages/tool-lint-ts/tests/index.test.ts packages/tool-lint-py/tests/index.test.ts packages/tool-lint-sh/tests/index.test.ts packages/tool-lint-c/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "lint-2"
$V run packages/tool-lint-rs/tests/index.test.ts packages/tool-lint-go/tests/index.test.ts packages/tool-lint-sql/tests/index.test.ts packages/tool-lint-core/tests/index.test.ts packages/tool-pyright/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "memory+model"
$V run packages/memory-palace/tests/index.test.ts packages/memory-palace/tests/sqlite-adapter.test.ts packages/model-config/tests/config-loader.test.ts packages/model-client/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "agent+prompt+correction"
$V run packages/agent-core/tests/index.test.ts packages/prompt-core/tests/index.test.ts packages/correction-core/tests/index.test.ts packages/correction-core/tests/boundary.test.ts packages/correction-core/tests/task-validator.test.ts packages/correction-core/tests/bench-normalize.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "plugin+orch-1"
$V run packages/plugin/tests/index.test.ts packages/orchestrator/tests/index.test.ts packages/orchestrator/tests/validator.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "orch-2"
$V run packages/orchestrator/tests/validator-contract.test.ts packages/orchestrator/tests/coverage.test.ts packages/orchestrator/tests/decompose.test.ts packages/orchestrator/tests/chaos.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "orch-fuzz"
$V run packages/orchestrator/tests/fuzz/path-safety.fuzz.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "cli"
$V run apps/cli/tests/cli-commands.test.ts apps/cli/tests/doctor.test.ts apps/cli/tests/observe.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

echo ""
[ "$FAIL" -eq 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $FAIL
