# Health Server Load Test

A reproducible load test for KirkForge's `HealthServer`. Spawns the server
in-process with a static API key and disabled per-IP rate limiting, then
fires a configurable mix of concurrent tenant traffic at the live endpoints
and reports latency percentiles, throughput, status-code breakdown, and
auth-failure rate.

## What it measures

| Metric               | Source                                        |
| -------------------- | --------------------------------------------- |
| p50 / p95 / p99 / max| Per-request wall-clock latency                |
| Throughput           | Total requests ÷ total wall-clock             |
| Status-code breakdown| One row per HTTP status seen                  |
| Auth failure rate    | 401 + 403 responses ÷ total                   |
| Rate-limit hits      | 429 responses ÷ total                         |
| Errors               | Connection errors / timeouts                  |

## What it does *not* measure

- CPU / memory / GC pressure (use `node --prof` for that)
- Concurrent *worker* token cost (covered by `bench/kirkforge-mini/`)
- TLS overhead (the test uses plain HTTP)
- Real OpenRouter API traffic (this is internal loopback only)

## How to run

From the repository root:

```bash
# Build once so the load test can import from packages/*/dist
npm run build

# Default run: 50 tenants × 100 requests, concurrency 20
node bench/load-test-health.mjs

# Tiny smoke run
node bench/load-test-health.mjs --tenants=2 --requests=10 --concurrency=2

# Full size with a tighter baseline
node bench/load-test-health.mjs --tenants=100 --requests=200 --concurrency=50 \
                                --baseline-ms=25
```

## CLI flags

| Flag                | Default | Description                                          |
| ------------------- | ------- | ---------------------------------------------------- |
| `--tenants`         | 50      | Number of distinct "tenants" to simulate             |
| `--requests`        | 100     | Requests per tenant                                  |
| `--concurrency`     | 20      | Maximum concurrent tenants in flight                 |
| `--authFail`        | 0.02    | Fraction of requests sent with an invalid bearer     |
| `--rateLimitSeed`   | 0.01    | Fraction of requests targeting the same tenant bucket |
| `--baseline-ms`     | 50      | p99 baseline in ms; fails if p99 > 1.2× this         |

Equivalent environment variable: `KIRKFORGE_LOAD_BASELINE_P99_MS`.

## Traffic mix

For each request, the load test randomly picks a path:

| Roll | Path           | Why                                     |
| ---- | -------------- | --------------------------------------- |
| 70%  | `/healthz`     | Liveness — the cheapest, hottest path   |
| 20%  | `/v1/metrics`  | Prometheus scrape — exercised in prod   |
| 10%  | `/v1/healthz`  | Auth-aware variant                      |

## Pass / fail

The script exits non-zero (1) when the measured p99 latency exceeds
`1.2 × baseline-ms`. This is a soft signal — raise the baseline if your
hardware is genuinely slower, but never silently grow it. A p99 regression
on this benchmark usually means one of:

- A new middleware on the request hot path
- An expensive synchronous operation in the auth check
- A logger that writes to disk in the request path
- A memory leak in the rate-limit `Map`

## Output

A JSON report is written to:

```
/tmp/kirkforge-load/load-<ISO-timestamp>.json
```

It contains both the raw `meta` (run config) and the aggregated `results`.
Check it into CI artifacts when investigating regressions.

## CI integration

The simplest CI gate is:

```bash
node bench/load-test-health.mjs --tenants=20 --requests=50
```

A non-zero exit blocks the build. The default settings run in ~2 seconds
on a 2-core CI runner; bump them up for the nightly regression suite.
