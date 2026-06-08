# Load Test Baseline & SLO Targets

This document defines the performance baselines and SLO targets for KirkForge
core operations. Baseline numbers are measured on typical CI runner hardware
(2-core, 4GB RAM) and should be re-benchmarked when significant changes land.

## Running Load Tests

```bash
# Run all load tests
npx vitest run tests/load/ --reporter=verbose

# Run just memory-palace load tests
npx vitest run tests/load/memory-palace-load.test.ts --reporter=verbose

# Run SLO monitor load tests
npx vitest run tests/load/slo-monitor-load.test.ts --reporter=verbose

# Run the HealthServer HTTP load test (live HTTP traffic, not in-process)
npm run build && node bench/load-test-health.mjs
```

## Memory Store SLO Targets

### InMemoryAdapter

| Operation                   | p50    | p95    | p99    | Throughput      |
| --------------------------- | ------ | ------ | ------ | --------------- |
| Single write                | <0.5ms | <1ms   | <2ms   | >50,000 ops/sec |
| Single read                 | <0.5ms | <1ms   | <2ms   | —               |
| Query by kind (200 results) | <10ms  | <50ms  | <100ms | —               |
| Recall (100 seeded)         | <20ms  | <100ms | <200ms | —               |

### FileAdapter

| Operation                     | p50   | p95   | p99    | Throughput     |
| ----------------------------- | ----- | ----- | ------ | -------------- |
| Write + persist (100 entries) | <20ms | <50ms | <100ms | >1,000 ops/sec |
| Read after persist            | <5ms  | <10ms | <20ms  | —              |

### SqliteAdapter

| Operation                                 | p50  | p95   | p99   | Throughput      |
| ----------------------------------------- | ---- | ----- | ----- | --------------- |
| Single write                              | <1ms | <5ms  | <10ms | >10,000 ops/sec |
| Single read                               | <1ms | <5ms  | <10ms | —               |
| WriteRun + emissions (1 run, 5 emissions) | <2ms | <10ms | <20ms | —               |
| Backup (10k rows)                         | —    | <5s   | <10s  | —               |
| Restore (10k rows)                        | —    | <5s   | <10s  | —               |

> **Note**: SqliteAdapter benchmarks require the `better-sqlite3` native
> binding, which is an optional dependency. Tests are skipped when the
> binding is unavailable.

## SLO Monitor SLO Targets

| Operation                                    | Threshold | Notes                       |
| -------------------------------------------- | --------- | --------------------------- |
| AuthPolicySloMonitor.record()                | p99 < 5ms | Single event recording      |
| AuthPolicySloMonitor.compute() (100k events) | <100ms    | Full SLO report computation |
| SloMonitor.compute() (10k observations)      | <5s       | Memory store query-based    |

## Enterprise SLO Definitions

### Auth Failure Rate

| Window | SLO Target     | Burn-rate Critical | Burn-rate Warning |
| ------ | -------------- | ------------------ | ----------------- |
| 7-day  | <1% failures   | 14.4x              | 10x               |
| 30-day | <0.1% failures | —                  | —                 |

### Policy Deny Rate

| Window | SLO Target  | Notes                                    |
| ------ | ----------- | ---------------------------------------- |
| 7-day  | <5% denials | Some denials are expected (bad requests) |

### Audit Write Success Rate

| Window | SLO Target     | Notes                                 |
| ------ | -------------- | ------------------------------------- |
| 7-day  | >99.9% success | Audit failures are critical incidents |

## HTTP Health Server SLO Targets

Measured by `bench/load-test-health.mjs` against an in-process
`HealthServer` with auth enabled and per-IP rate limiting disabled. The
test fires 5,000 requests (50 tenants × 100) with a 70/20/10 mix of
`/healthz`, `/v1/metrics`, and `/v1/healthz`, plus 2% invalid-bearer
seeding to exercise the 401/403 path.

| Operation             | p50   | p95   | p99   | Throughput      | SLO         |
| --------------------- | ----- | ----- | ----- | --------------- | ----------- |
| `/healthz` (liveness) | <10ms | <20ms | <30ms | >2,000 req/s    | p99 < 50ms  |
| `/v1/metrics` (Prom)  | <15ms | <25ms | <50ms | >1,500 req/s    | p99 < 50ms  |
| `/v1/healthz` (auth)  | <10ms | <20ms | <30ms | >2,000 req/s    | p99 < 50ms  |

The load test fails (exit 1) when measured p99 exceeds **1.2× the
configured baseline** (default 50ms). See `bench/load-test-health.README.md`
for run instructions and CI integration.

### Last Health Server Baseline

- **Date**: 2026-06-08
- **Environment**: CI runner (2-core, 4GB)
- **Node**: v24.16.0
- **Run config**: 50 tenants × 100 requests, concurrency 20
- **Measured**:
  - p50 = 7.33ms
  - p95 = 13.26ms
  - p99 = 16.53ms
  - max = 118.12ms
  - Throughput = 2,407 req/s
  - Status: 4,909 × 200, 91 × 403 (1.8% auth failures — matches the 2% seed)
  - Errors: 0
- **Verdict**: PASS — p99 well under 50ms baseline

## Re-benchmarking Procedure

1. Make no code changes to the path under test.
2. Run the load test suite 3 times on the target hardware.
3. Record the median p50/p95/p99 and throughput values.
4. Update this document with the new baselines.
5. Update `SLO` constants in the test files if thresholds need adjustment.

## Last Baseline Update

- **Date**: 2026-06-08
- **Environment**: CI runner (2-core, 4GB)
- **Node**: v24.16.0
- **Commit**: current HEAD
