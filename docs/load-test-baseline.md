# Load Test Baseline & SLO Targets

This document defines the performance baselines and SLO targets for 55NDeep
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

## Re-benchmarking Procedure

1. Make no code changes to the path under test.
2. Run the load test suite 3 times on the target hardware.
3. Record the median p50/p95/p99 and throughput values.
4. Update this document with the new baselines.
5. Update `SLO` constants in the test files if thresholds need adjustment.

## Last Baseline Update

- **Date**: 2026-05-22
- **Environment**: CI runner (2-core, 4GB)
- **Node**: v24.x
- **Commit**: current HEAD
