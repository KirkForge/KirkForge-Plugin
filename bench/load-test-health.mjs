// KirkForge health server load test.
//
// Spawns an in-process HealthServer with disabled auth (dev mode) and high
// rate limits, then fires 50 concurrent "tenants" × 100 requests each at
// /healthz and /v1/metrics, mixing 2% auth failures and 1% rate-limit
// pre-seeding to exercise the auth + rate-limit paths. Reports p50/p95/p99
// latency, success rate, auth failure rate, rate-limit hits, and total
// duration. Writes a JSON report to /tmp/kirkforge-load-<timestamp>.json
// and exits non-zero if p99 latency exceeds the baseline by >20%.
//
// Usage:
//   node bench/load-test-health.mjs
//   node bench/load-test-health.mjs --requests=50 --concurrency=10
//   node bench/load-test-health.mjs --baseline-ms=200
//
// Environment:
//   KIRKFORGE_LOAD_BASELINE_P99_MS — override the p99 baseline (default 50ms)

import http from "node:http";
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lazy-load the orchestrator modules from the workspace root so the script
// works from anywhere inside the repo.
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const { HealthServer } = await import(
  join(REPO_ROOT, "packages/orchestrator/dist/health-server.js")
);
const { Orchestrator } = await import(
  join(REPO_ROOT, "packages/orchestrator/dist/index.js")
);
const { EventBus } = await import(
  join(REPO_ROOT, "packages/core-events/dist/index.js")
);
const { MemoryStore, InMemoryAdapter } = await import(
  join(REPO_ROOT, "packages/memory-palace/dist/index.js")
);

// ── Args ────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? "true"];
    }),
);
const TENANTS = Number(args.tenants ?? 50);
const REQUESTS_PER_TENANT = Number(args.requests ?? 100);
const CONCURRENCY = Number(args.concurrency ?? 20);
const AUTH_FAILURE_RATE = Number(args.authFail ?? 0.02);
const RATE_LIMIT_SEED = Number(args.rateLimitSeed ?? 0.01);
const BASELINE_P99_MS = Number(
  args["baseline-ms"] ?? process.env.KIRKFORGE_LOAD_BASELINE_P99_MS ?? 50,
);

// ── Start the server ────────────────────────────────────────────────────
const bus = new EventBus();
const store = new MemoryStore(new InMemoryAdapter());
const orchestrator = new Orchestrator({
  modelConfig: { providers: {}, defaultProvider: "test" },
  eventBus: bus,
  memoryStore: store,
});

// Use a static API key so the auth-failure path is actually exercised. With
// no apiKey configured, dev mode returns the internal admin actor for every
// request and 401s never happen.
const API_KEY = "kirkforge-loadtest-" + Math.random().toString(36).slice(2, 10);

const server = new HealthServer(orchestrator, {
  port: 0,
  host: "127.0.0.1",
  apiKey: API_KEY,
  // Disable rate limit per-IP for the load test so we measure the server's
  // own latency, not throttling. Per-tenant throttling is still exercised
  // when RATE_LIMIT_SEED > 0.
  rateLimitPerSec: 1_000_000,
  rateLimitPerSecPerTenant: 1000,
});
await server.start();
const addr = server.server.address();
if (!addr || typeof addr !== "object") {
  console.error("FATAL: server did not bind");
  process.exit(2);
}
const port = addr.port;
console.log(
  `[load] server up on 127.0.0.1:${port}; tenants=${TENANTS} reqs/tenant=${REQUESTS_PER_TENANT} concurrency=${CONCURRENCY}`,
);

// ── Worker pool ─────────────────────────────────────────────────────────
/** @type {Array<{ status: number; durationMs: number; error?: string; tenantId: string; path: string }>} */
const results = [];
let completed = 0;
const TOTAL = TENANTS * REQUESTS_PER_TENANT;

async function fireOne(tenantId, path) {
  // Mix valid and invalid bearer tokens to exercise both the 200 and 401
  // paths. The rate-limit seed works the same way: hit the same tenant
  // fast enough to land in the rate-limit bucket.
  const headers = { "X-Tenant-Id": tenantId };
  if (Math.random() < AUTH_FAILURE_RATE) {
    headers["Authorization"] = "Bearer invalid-token-for-loadtest";
  } else {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }
  const start = performance.now();
  return await new Promise((resolve) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers,
        timeout: 10_000,
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          const durationMs = performance.now() - start;
          results.push({ status: res.statusCode ?? 0, durationMs, tenantId, path });
          resolve(undefined);
        });
      },
    );
    req.on("error", (err) => {
      const durationMs = performance.now() - start;
      results.push({ status: 0, durationMs, error: err.message, tenantId, path });
      resolve(undefined);
    });
    req.end();
  });
}

async function runTenant(tenantId) {
  // 70% /healthz, 20% /v1/metrics, 10% /v1/healthz (mirrors real traffic mix)
  for (let i = 0; i < REQUESTS_PER_TENANT; i++) {
    const roll = Math.random();
    const path =
      roll < 0.7 ? "/healthz" : roll < 0.9 ? "/v1/metrics" : "/v1/healthz";
    await fireOne(tenantId, path);
    completed++;
    if (completed % 500 === 0) {
      console.log(`[load] progress: ${completed}/${TOTAL}`);
    }
  }
}

const tenantIds = Array.from({ length: TENANTS }, (_, i) => `load-tenant-${i}`);
// Run tenants with bounded concurrency. Semaphore is just an inline queue.
let inflight = 0;
const tenantQueue = [...tenantIds];
async function scheduler() {
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(
      (async () => {
        while (tenantQueue.length > 0) {
          const tid = tenantQueue.shift();
          if (!tid) return;
          inflight++;
          await runTenant(tid);
          inflight--;
        }
      })(),
    );
  }
  await Promise.all(workers);
}

const startWall = performance.now();
await scheduler();
const elapsedMs = performance.now() - startWall;

// ── Aggregate ───────────────────────────────────────────────────────────
const sorted = results.map((r) => r.durationMs).sort((a, b) => a - b);
const pct = (p) => sorted[Math.floor((sorted.length - 1) * p)] ?? 0;
const p50 = pct(0.5);
const p95 = pct(0.95);
const p99 = pct(0.99);
const max = sorted[sorted.length - 1] ?? 0;

const byStatus = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, /** @type {Record<number, number>} */ ({}));
const success = (byStatus[200] ?? 0) + (byStatus[503] ?? 0); // 503 is "expected" when shutting down
// Both 401 (missing/invalid bearer) and 403 (invalid API key) count as
// auth failures for the purposes of this test.
const authFailures = (byStatus[401] ?? 0) + (byStatus[403] ?? 0);
const rateLimitHits = byStatus[429] ?? 0;
const errors = results.filter((r) => r.error).length;

const report = {
  meta: {
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    tenants: TENANTS,
    requestsPerTenant: REQUESTS_PER_TENANT,
    concurrency: CONCURRENCY,
    authFailureRate: AUTH_FAILURE_RATE,
    rateLimitSeed: RATE_LIMIT_SEED,
  },
  results: {
    total: results.length,
    elapsedMs: Math.round(elapsedMs),
    rps: Math.round((results.length / elapsedMs) * 1000),
    p50Ms: Math.round(p50 * 100) / 100,
    p95Ms: Math.round(p95 * 100) / 100,
    p99Ms: Math.round(p99 * 100) / 100,
    maxMs: Math.round(max * 100) / 100,
    byStatus,
    success,
    authFailures,
    rateLimitHits,
    errors,
  },
  baseline: {
    p99Ms: BASELINE_P99_MS,
    threshold: Math.round(BASELINE_P99_MS * 1.2 * 100) / 100,
    pass: Math.round(p99 * 100) / 100 <= Math.round(BASELINE_P99_MS * 1.2 * 100) / 100,
  },
};

// Write report
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(tmpdir(), "kirkforge-load");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `load-${ts}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

// ── Print summary ───────────────────────────────────────────────────────
console.log("\n────────── KirkForge Health Server Load Test ──────────");
console.log(`URL                : http://127.0.0.1:${port}`);
console.log(`Total requests     : ${report.results.total}`);
console.log(`Elapsed            : ${(report.results.elapsedMs / 1000).toFixed(2)}s`);
console.log(`Throughput         : ${report.results.rps} req/s`);
console.log(`Latency p50        : ${report.results.p50Ms}ms`);
console.log(`Latency p95        : ${report.results.p95Ms}ms`);
console.log(`Latency p99        : ${report.results.p99Ms}ms`);
console.log(`Latency max        : ${report.results.maxMs}ms`);
console.log(`Status breakdown   : ${JSON.stringify(byStatus)}`);
console.log(`Auth failures      : ${authFailures} (${((authFailures / results.length) * 100).toFixed(1)}%)`);
console.log(`Rate-limit hits    : ${rateLimitHits}`);
console.log(`Errors             : ${errors}`);
console.log(`Baseline p99       : ${BASELINE_P99_MS}ms (threshold ${report.baseline.threshold}ms)`);
console.log(`Result             : ${report.baseline.pass ? "PASS ✓" : "FAIL ✗ (p99 exceeds 1.2× baseline)"}`);
console.log(`Report written     : ${outPath}`);
console.log("──────────────────────────────────────────────────────");

// Cleanup
await server.stop();
await bus.gracefulShutdown();
process.exit(report.baseline.pass ? 0 : 1);
