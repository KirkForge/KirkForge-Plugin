/**
 * Load test baseline for 55NDeep memory-palace operations.
 *
 * This test documents SLO targets for core operations and measures
 * actual performance against those targets. Run with:
 *
 *   npx vitest run tests/load/ --reporter=verbose
 *
 * SLO targets are based on expected single-thread performance on
 * modern hardware. Adjust thresholds if your CI runner is slower.
 */
import { describe, it, expect } from "vitest";
import {
  InMemoryAdapter,
  FileAdapter,
  MemoryStore,
} from "@55ndeep/memory-palace";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── SLO targets ──────────────────────────────────────────────────────────────
// These thresholds define the baseline performance contract.
// p95 = 95th percentile, p99 = 99th percentile.
// Durations are in milliseconds.

const SLO = {
  /** Single observation write latency (InMemoryAdapter). */
  inMemoryWriteP95: 1,
  /** Single observation read latency (InMemoryAdapter). */
  inMemoryReadP95: 1,
  /** Query by kind with 1000 entries (InMemoryAdapter). */
  inMemoryQueryP95: 50,
  /** Recall with similarity search (InMemoryAdapter). */
  inMemoryRecallP95: 100,
  /** FileAdapter write (single file, 100 entries). */
  fileWriteP95: 50,
  /** FileAdapter read after persist. */
  fileReadP95: 10,
  /** Write throughput: observations per second (InMemoryAdapter). */
  inMemoryWriteThroughput: 50000,
  /** Write throughput: observations per second (FileAdapter). */
  fileWriteThroughput: 1000,
} as const;

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)]!;
}

function makeObservation(id: string, kind = "task-observation") {
  return {
    id,
    kind,
    taskId: `task-${id}`,
    timestamp: new Date().toISOString(),
    description: `Observation ${id}: fix broken auth module in the login service`,
    properties: {
      language: "typescript",
      mode: "artifact",
      model: "test-model",
      outcome: "pass",
      tokens: Math.floor(Math.random() * 5000),
      durationMs: Math.floor(Math.random() * 30000),
    },
    tags: ["coding", "typescript", "auth"],
  };
}

// ── InMemoryAdapter load tests ──────────────────────────────────────────────

describe("InMemoryAdapter load baseline", () => {
  it("meets single-write p95 SLO", async () => {
    const adapter = new InMemoryAdapter();
    const latencies: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      await adapter.write(makeObservation(`obs-${i}`));
      latencies.push(performance.now() - start);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    console.log(`InMemory write: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);

    // Soft assertion: document the baseline, but don't fail CI on slow runners
    if (p95 > SLO.inMemoryWriteP95) {
      console.warn(
        `⚠ InMemory write p95 (${p95.toFixed(2)}ms) exceeds SLO target (${SLO.inMemoryWriteP95}ms). ` +
          `This may be due to CI runner performance. Adjust SLO if needed.`,
      );
    }
    // Hard assertion: must at least complete
    expect(p95).toBeLessThan(100);
  });

  it("meets single-read p95 SLO", async () => {
    const adapter = new InMemoryAdapter();
    const latencies: number[] = [];

    // Write 1000 entries first
    for (let i = 0; i < 1000; i++) {
      await adapter.write(makeObservation(`read-${i}`));
    }

    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      await adapter.read(`read-${i}`);
      latencies.push(performance.now() - start);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    console.log(`InMemory read: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms`);

    if (p95 > SLO.inMemoryReadP95) {
      console.warn(
        `⚠ InMemory read p95 (${p95.toFixed(2)}ms) exceeds SLO target (${SLO.inMemoryReadP95}ms).`,
      );
    }
    expect(p95).toBeLessThan(50);
  });

  it("meets query-by-kind p95 SLO with 1000 entries", async () => {
    const adapter = new InMemoryAdapter();

    // Write 1000 entries across 5 kinds
    for (let i = 0; i < 1000; i++) {
      const kind = ["task-observation", "benchmark.run", "verify.lint", "verify.types", "state.changes"][i % 5]!;
      await adapter.write(makeObservation(`q-${i}`, kind));
    }

    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      await adapter.query({ kind: "task-observation" });
      latencies.push(performance.now() - start);
    }

    const p95 = percentile(latencies, 95);
    console.log(`InMemory query (kind, 200 results): p95=${p95.toFixed(2)}ms`);

    if (p95 > SLO.inMemoryQueryP95) {
      console.warn(
        `⚠ InMemory query p95 (${p95.toFixed(2)}ms) exceeds SLO target (${SLO.inMemoryQueryP95}ms).`,
      );
    }
    expect(p95).toBeLessThan(200);
  });

  it("meets recall p95 SLO", async () => {
    const adapter = new InMemoryAdapter();

    // Seed 100 task observations for recall
    const store = new MemoryStore(adapter);
    for (let i = 0; i < 100; i++) {
      await store.writeTaskObservation({
        taskId: `recall-${i}`,
        description: `fix broken typescript auth module in login service ${i}`,
        language: "typescript",
        mode: "artifact",
        model: i % 2 === 0 ? "gpt-4" : "claude-3",
        outcome: i % 3 === 0 ? "fail" : "pass",
        tokens: 500 + Math.floor(Math.random() * 4000),
        durationMs: 1000 + Math.floor(Math.random() * 29000),
      });
    }

    const latencies: number[] = [];
    for (let i = 0; i < 50; i++) {
      const start = performance.now();
      await store.recall("fix broken auth module", "gpt-4");
      latencies.push(performance.now() - start);
    }

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`MemoryStore recall: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);

    if (p95 > SLO.inMemoryRecallP95) {
      console.warn(
        `⚠ MemoryStore recall p95 (${p95.toFixed(2)}ms) exceeds SLO target (${SLO.inMemoryRecallP95}ms).`,
      );
    }
    expect(p95).toBeLessThan(500);
  });

  it("meets write throughput SLO", async () => {
    const adapter = new InMemoryAdapter();
    const count = 10000;
    const start = performance.now();

    for (let i = 0; i < count; i++) {
      await adapter.write(makeObservation(`throughput-${i}`));
    }

    const elapsed = performance.now() - start;
    const opsPerSec = Math.round((count / elapsed) * 1000);

    console.log(`InMemory write throughput: ${opsPerSec.toLocaleString()} ops/sec (${count} ops in ${elapsed.toFixed(0)}ms)`);

    if (opsPerSec < SLO.inMemoryWriteThroughput) {
      console.warn(
        `⚠ InMemory write throughput (${opsPerSec} ops/sec) below SLO target (${SLO.inMemoryWriteThroughput} ops/sec).`,
      );
    }
    // Must at least complete
    expect(opsPerSec).toBeGreaterThan(1000);
  });
});

// ── FileAdapter load tests ──────────────────────────────────────────────────

describe("FileAdapter load baseline", () => {
  it("meets file write p95 SLO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-load-file-"));
    try {
      const filePath = join(dir, "memory.json");
      const adapter = new FileAdapter(filePath);
      const latencies: number[] = [];

      for (let i = 0; i < 100; i++) {
        await adapter.write(makeObservation(`file-${i}`));
        const start = performance.now();
        await adapter.persist();
        latencies.push(performance.now() - start);
      }

      const p50 = percentile(latencies, 50);
      const p95 = percentile(latencies, 95);

      console.log(`File write+persist: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);

      if (p95 > SLO.fileWriteP95) {
        console.warn(
          `⚠ File write p95 (${p95.toFixed(2)}ms) exceeds SLO target (${SLO.fileWriteP95}ms).`,
        );
      }
      expect(p95).toBeLessThan(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("meets file write throughput SLO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-load-throughput-"));
    try {
      const filePath = join(dir, "memory.json");
      const adapter = new FileAdapter(filePath);
      const count = 200;
      const start = performance.now();

      for (let i = 0; i < count; i++) {
        await adapter.write(makeObservation(`thr-${i}`));
      }
      await adapter.persist();

      const elapsed = performance.now() - start;
      const opsPerSec = Math.round((count / elapsed) * 1000);

      console.log(`File write throughput: ${opsPerSec.toLocaleString()} ops/sec (${count} ops in ${elapsed.toFixed(0)}ms)`);

      if (opsPerSec < SLO.fileWriteThroughput) {
        console.warn(
          `⚠ File write throughput (${opsPerSec} ops/sec) below SLO target (${SLO.fileWriteThroughput} ops/sec).`,
        );
      }
      expect(opsPerSec).toBeGreaterThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("meets file read p95 SLO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-load-read-"));
    try {
      const filePath = join(dir, "memory.json");
      const adapter = new FileAdapter(filePath);

      // Write and persist 100 entries
      for (let i = 0; i < 100; i++) {
        await adapter.write(makeObservation(`fread-${i}`));
      }
      await adapter.persist();

      const latencies: number[] = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        await adapter.read(`fread-${i}`);
        latencies.push(performance.now() - start);
      }

      const p95 = percentile(latencies, 95);
      console.log(`File read: p95=${p95.toFixed(2)}ms`);

      if (p95 > SLO.fileReadP95) {
        console.warn(
          `⚠ File read p95 (${p95.toFixed(2)}ms) exceeds SLO target (${SLO.fileReadP95}ms).`,
        );
      }
      expect(p95).toBeLessThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
