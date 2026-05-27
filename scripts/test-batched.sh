#!/usr/bin/env bash
# Test runner that batches test files into groups for parallel execution.
# Each group runs in a separate vitest process to limit memory and CPU.
set -euo pipefail

V="node node_modules/.bin/vitest"
R="--reporter=dot"
L="/tmp/55n-test.log"
FAIL=0

echo "=== Test Suite ==="

printf "  %-40s " "core-types+logging+tenancy"
$V run packages/core-types/tests/result.test.ts packages/core-logging/tests/index.test.ts packages/core-tenancy/tests/index.test.ts packages/core-tenancy/tests/isolation.test.ts packages/core-telemetry/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "core-secrets+rbac+policy"
$V run packages/core-secrets/tests/sigv4.test.ts packages/core-secrets/tests/redaction.test.ts packages/core-secrets/tests/tenant-key.test.ts packages/core-rbac/tests/index.test.ts packages/core-rbac/tests/jwt-verify.test.ts packages/core-policy/tests/index.test.ts packages/core-policy/tests/signed-policy.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "core-events+enterprise+sandbox"
$V run packages/core-events/tests/index.test.ts packages/core-events/tests/audit.test.ts packages/core-events/tests/worm-audit.test.ts packages/core-enterprise/tests/index.test.ts packages/core-enterprise/tests/quotas.test.ts packages/core-enterprise/tests/quota-persistence.test.ts packages/core-enterprise/tests/enterprise-integration.test.ts packages/core-sandbox/tests/index.test.ts packages/core-sandbox/tests/runner.test.ts packages/core-sandbox/tests/escape-prevention.test.ts packages/core-flags/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "lint-tools"
$V run packages/tool-lint-ts/tests/index.test.ts packages/tool-lint-py/tests/index.test.ts packages/tool-lint-sh/tests/index.test.ts packages/tool-lint-c/tests/index.test.ts packages/tool-lint-rs/tests/index.test.ts packages/tool-lint-go/tests/index.test.ts packages/tool-lint-sql/tests/index.test.ts packages/tool-lint-core/tests/index.test.ts packages/tool-pyright/tests/index.test.ts packages/tool-tsc/tests/index.test.ts packages/tool-gitnexus/tests/index.test.ts packages/tool-graphify/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "memory+model"
$V run packages/memory-palace/tests/index.test.ts packages/memory-palace/tests/sqlite-adapter.test.ts packages/memory-palace/tests/sqlite-backup.test.ts packages/model-config/tests/config-loader.test.ts packages/model-client/tests/index.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "agent+prompt+correction"
$V run packages/agent-core/tests/index.test.ts packages/prompt-core/tests/index.test.ts packages/correction-core/tests/index.test.ts packages/correction-core/tests/boundary.test.ts packages/correction-core/tests/task-validator.test.ts packages/correction-core/tests/bench-normalize.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "plugin+orch"
$V run packages/plugin/tests/index.test.ts packages/plugin/tests/auth-audit-bridge.test.ts packages/orchestrator/tests/index.test.ts packages/orchestrator/tests/validator.test.ts packages/orchestrator/tests/validator-contract.test.ts packages/orchestrator/tests/coverage.test.ts packages/orchestrator/tests/decompose.test.ts packages/orchestrator/tests/chaos.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "cli+e2e"
$V run apps/cli/tests/cli-commands.test.ts apps/cli/tests/doctor.test.ts apps/cli/tests/observe.test.ts e2e/smoke.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

printf "  %-40s " "load-baseline"
$V run tests/load/memory-palace-load.test.ts tests/load/slo-monitor-load.test.ts tests/load/enterprise-load.test.ts $R > $L 2>&1 && echo "PASS" || { echo "FAIL"; tail -10 $L; FAIL=1; }

echo ""
[ "$FAIL" -eq 0 ] && echo "ALL TESTS PASSED" || echo "SOME TESTS FAILED"
exit $FAIL
