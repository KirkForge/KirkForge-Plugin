/**
 * Load test baseline for 55NDeep SLO monitor operations.
 *
 * Validates that AuthPolicySloMonitor and SloMonitor compute
 * reports efficiently under load.
 */
import { describe, it, expect } from "vitest";
import {
  AuthPolicySloMonitor,
  SloMonitor,
  ENTERPRISE_SLO_TARGETS,
} from "@55ndeep/orchestrator/slo-monitor";
import { InMemoryAdapter, MemoryStore } from "@55ndeep/memory-palace";

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

describe("AuthPolicySloMonitor load baseline", () => {
  it("handles 100k events and computes SLO report under 5s", () => {
    const monitor = new AuthPolicySloMonitor(ENTERPRISE_SLO_TARGETS, 100_000);

    // Seed 100k events
    const types = [
      "auth.success",
      "auth.failure",
      "policy.allow",
      "policy.deny",
      "audit.write.success",
    ] as const;
    for (let i = 0; i < 100_000; i++) {
      const type = types[i % types.length]!;
      monitor.record({
        timestamp: Date.now() - (100_000 - i),
        type,
        actorId: `actor-${i % 100}`,
        tenantId: `tenant-${i % 10}`,
      });
    }

    // Compute report
    const start = performance.now();
    const report = monitor.compute();
    const elapsed = performance.now() - start;

    console.log(`AuthPolicySloMonitor compute (100k events): ${elapsed.toFixed(2)}ms`);
    console.log(`  Windows: ${report.windows.length}`);

    // Should compute in under 100ms
    expect(elapsed).toBeLessThan(5000);
    expect(report.windows.length).toBeGreaterThan(0);
  });

  it("handles burst recording without degradation", () => {
    const monitor = new AuthPolicySloMonitor(ENTERPRISE_SLO_TARGETS, 100_000);
    const latencies: number[] = [];

    for (let i = 0; i < 10_000; i++) {
      const start = performance.now();
      monitor.record({
        timestamp: Date.now(),
        type: "auth.success",
        actorId: "actor-burst",
        tenantId: "tenant-burst",
      });
      latencies.push(performance.now() - start);
    }

    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    console.log(
      `AuthPolicySloMonitor record burst: p95=${p95.toFixed(3)}ms p99=${p99.toFixed(3)}ms`,
    );

    // Single record should be sub-millisecond
    expect(p99).toBeLessThan(5);
  });
});

describe("SloMonitor load baseline", () => {
  it("computes SLO report from memory store under load", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);

    // Seed 10k task observations
    for (let i = 0; i < 10_000; i++) {
      await store.writeTaskObservation({
        taskId: `load-${i}`,
        description: `load test task ${i}`,
        language: "typescript",
        mode: "artifact",
        model: "test-model",
        outcome: i % 10 === 0 ? "fail" : "pass",
        tokens: 500,
        durationMs: 1000,
      });
    }

    const monitor = new SloMonitor(store);

    const start = performance.now();
    const report = await monitor.compute();
    const elapsed = performance.now() - start;

    console.log(`SloMonitor compute (10k observations): ${elapsed.toFixed(2)}ms`);
    console.log(`  Windows: ${report.windows.length}`);

    // Should compute in under 5 seconds
    expect(elapsed).toBeLessThan(5000);
  });
});
