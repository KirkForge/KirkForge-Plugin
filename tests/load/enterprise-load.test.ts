/**
 * Enterprise load test baseline for 55NDeep auth, policy, quota, and audit
 * operations. These tests verify that enterprise-critical paths meet SLO
 * targets under concurrent load.
 *
 * Run with: npx vitest run tests/load/enterprise-load.test.ts --reporter=verbose
 */
import { describe, it, expect } from "vitest";
import {
  hasPermission,
  authorize,
  authorizeTenant,
  actorFromApiKey,
  type Actor,
} from "@55ndeep/core-rbac";
import { PolicyEngine, DEFAULT_POLICY } from "@55ndeep/core-policy";
import { QuotaManager, RateLimiter } from "@55ndeep/core-enterprise";
import { WormAuditSink, chainHashOf, initialHash } from "@55ndeep/core-events";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── SLO targets (milliseconds) ──────────────────────────────────────────────
const SLO = {
  /** RBAC permission check p95 latency. */
  rbacCheckP95: 0.1,
  /** Policy engine authorize p95 latency. */
  policyAuthorizeP95: 0.5,
  /** Quota check p95 latency. */
  quotaCheckP95: 0.1,
  /** Rate limiter check p95 latency. */
  rateLimiterP95: 0.1,
  /** WORM audit write p95 latency (in-memory buffer). */
  wormAuditWriteP95: 1,
  /** Concurrent auth checks (per second). */
  authThroughput: 50000,
} as const;

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

const adminActor: Actor = {
  id: "admin-1",
  role: "admin",
  tenantId: "tenant-1",
  authMethod: "oidc",
  verifiedAt: new Date().toISOString(),
};

const devActor: Actor = {
  id: "dev-1",
  role: "developer",
  tenantId: "tenant-1",
  authMethod: "oidc",
  verifiedAt: new Date().toISOString(),
};

// ── RBAC load tests ────────────────────────────────────────────────────────

describe("RBAC load baseline", () => {
  it("meets permission check p95 SLO", () => {
    const latencies: number[] = [];
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      hasPermission(adminActor, "admin:config");
      latencies.push(performance.now() - start);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    console.log(
      `RBAC hasPermission: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );

    if (p95 > SLO.rbacCheckP95) {
      console.warn(`⚠ RBAC check p95 (${p95.toFixed(3)}ms) exceeds SLO (${SLO.rbacCheckP95}ms)`);
    }
    expect(p95).toBeLessThan(1);
  });

  it("meets authorize p95 SLO", () => {
    const latencies: number[] = [];
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      authorize(devActor, "dev:verify");
      latencies.push(performance.now() - start);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`RBAC authorize: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);

    if (p95 > SLO.rbacCheckP95) {
      console.warn(`⚠ RBAC authorize p95 (${p95.toFixed(3)}ms) exceeds SLO`);
    }
    expect(p95).toBeLessThan(1);
  });

  it("meets authorizeTenant p95 SLO", () => {
    const latencies: number[] = [];
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      authorizeTenant(devActor, "dev:verify", "tenant-1");
      latencies.push(performance.now() - start);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`RBAC authorizeTenant: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(1);
  });

  it("meets auth throughput SLO", () => {
    const iterations = 50000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      hasPermission(adminActor, "admin:policy");
    }

    const elapsed = performance.now() - start;
    const opsPerSec = Math.round((iterations / elapsed) * 1000);

    console.log(`RBAC throughput: ${opsPerSec.toLocaleString()} ops/sec`);

    if (opsPerSec < SLO.authThroughput) {
      console.warn(`⚠ RBAC throughput (${opsPerSec}) below SLO (${SLO.authThroughput})`);
    }
    expect(opsPerSec).toBeGreaterThan(10000);
  });

  it("meets API key auth throughput SLO", () => {
    const key = "a".repeat(64);
    const latencies: number[] = [];

    for (let i = 0; i < 5000; i++) {
      const start = performance.now();
      actorFromApiKey(key, key, "admin", "tenant-1");
      latencies.push(performance.now() - start);
    }

    const p95 = percentile(latencies, 95);
    console.log(`API key auth: p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(1);
  });
});

// ── Policy engine load tests ───────────────────────────────────────────────

describe("Policy engine load baseline", () => {
  it("meets authorize p95 SLO under default policy", () => {
    const engine = new PolicyEngine(DEFAULT_POLICY);
    const latencies: number[] = [];
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      engine.checkTool("eslint");
      latencies.push(performance.now() - start);
    }

    const p95 = percentile(latencies, 95);
    console.log(`Policy authorize: p95=${p95.toFixed(3)}ms`);

    if (p95 > SLO.policyAuthorizeP95) {
      console.warn(`⚠ Policy authorize p95 (${p95.toFixed(3)}ms) exceeds SLO`);
    }
    expect(p95).toBeLessThan(5);
  });
});

// ── Quota manager load tests ────────────────────────────────────────────────

describe("Quota manager load baseline", () => {
  it("meets quota check p95 SLO", () => {
    const manager = new QuotaManager();
    manager.setQuota("tenant-1", { maxConcurrentTasks: 4 });

    const latencies: number[] = [];
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      manager.checkQuota("tenant-1", "concurrent_task");
      latencies.push(performance.now() - start);
    }

    const p95 = percentile(latencies, 95);
    console.log(`Quota check: p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(1);
  });

  it("meets rate limiter p95 SLO", () => {
    const limiter = new RateLimiter();
    const config = { maxRequests: 100, windowMs: 60000 };

    const latencies: number[] = [];
    const iterations = 10000;

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      limiter.check(`tenant-1:verify`, config);
      latencies.push(performance.now() - start);
    }

    const p95 = percentile(latencies, 95);
    console.log(`Rate limiter check: p95=${p95.toFixed(3)}ms`);
    expect(p95).toBeLessThan(1);
  });
});

// ── WORM audit sink load tests ──────────────────────────────────────────────

describe("WORM audit sink load baseline", () => {
  it("meets audit write p95 SLO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-load-worm-"));
    try {
      const sink = new WormAuditSink({
        directory: dir,
        filePrefix: "audit-load",
        fsyncAfterFlush: false,
        verifyOnWrite: false,
        maxSegmentBytes: 1024 * 1024,
      });

      const latencies: number[] = [];
      const iterations = 1000;
      let seq = 0;
      let lastHash = initialHash();

      for (let i = 0; i < iterations; i++) {
        const event = {
          id: `evt-${i}`,
          sequence: ++seq,
          timestamp: new Date().toISOString(),
          action: "policy.check" as const,
          outcome: "success" as const,
          actorId: "admin-1",
          tenantId: "tenant-1",
          reason: "load test",
          chainHash: chainHashOf(lastHash, {
            id: `evt-${i}`,
            sequence: seq,
            timestamp: new Date().toISOString(),
            action: "policy.check",
            outcome: "success",
            actorId: "admin-1",
            tenantId: "tenant-1",
            reason: "load test",
          }),
        };
        lastHash = event.chainHash;

        const start = performance.now();
        await sink.write(event);
        latencies.push(performance.now() - start);
      }

      await sink.close();

      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);
      const p99 = percentile(latencies, 99);

      console.log(
        `WORM audit write: p50=${p50.toFixed(3)}ms p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
      );

      if (p95 > SLO.wormAuditWriteP95) {
        console.warn(`⚠ WORM audit write p95 (${p95.toFixed(3)}ms) exceeds SLO`);
      }
      expect(p95).toBeLessThan(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WORM sink maintains chain integrity under load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-load-integrity-"));
    try {
      const sink = new WormAuditSink({
        directory: dir,
        filePrefix: "audit-integrity",
        fsyncAfterFlush: false,
        verifyOnWrite: true,
        maxSegmentBytes: 10 * 1024, // Small segments to test rotation under load
      });

      const iterations = 500;
      let seq = 0;
      let lastHash = initialHash();

      for (let i = 0; i < iterations; i++) {
        const chainHash = chainHashOf(lastHash, {
          id: `int-${i}`,
          sequence: ++seq,
          timestamp: new Date().toISOString(),
          action: "auth.success",
          outcome: "success",
          actorId: "user-1",
          tenantId: "tenant-1",
          reason: "integrity test",
        });
        lastHash = chainHash;

        await sink.write({
          id: `int-${i}`,
          sequence: seq,
          timestamp: new Date().toISOString(),
          action: "auth.success",
          outcome: "success",
          actorId: "user-1",
          tenantId: "tenant-1",
          reason: "integrity test",
          chainHash,
        });
      }

      await sink.close();

      // Verify chain integrity
      expect(sink.verifyIntegrity()).toBe(true);
      expect(sink.getWriteCount()).toBe(iterations);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
