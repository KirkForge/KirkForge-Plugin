import { describe, it, expect } from "vitest";
import { SecdevEmitter } from "../src/index.js";
import { EventBus } from "@55ndeep/core-events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("SecdevEmitter", () => {
  it("detects hardcoded AWS key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-secdev-"));
    const bus = new EventBus();
    try {
      writeFileSync(join(dir, "test.ts"), 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
      const emitter = new SecdevEmitter({ cwd: dir, eventBus: bus });
      const result = await emitter.emit("t1", ["test.ts"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.findings).toBeGreaterThanOrEqual(1);
        expect(result.value.high).toBeGreaterThanOrEqual(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects eval() usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-secdev-"));
    const bus = new EventBus();
    try {
      writeFileSync(join(dir, "test.ts"), "eval('something');\n");
      const emitter = new SecdevEmitter({ cwd: dir, eventBus: bus });
      const result = await emitter.emit("t2", ["test.ts"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.critical).toBeGreaterThanOrEqual(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns clean on safe file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-secdev-"));
    const bus = new EventBus();
    try {
      writeFileSync(join(dir, "test.ts"), "const x = 42;\n");
      const emitter = new SecdevEmitter({ cwd: dir, eventBus: bus });
      const result = await emitter.emit("t3", ["test.ts"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.findings).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects Stripe live key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "55ndeep-secdev-"));
    const bus = new EventBus();
    try {
      writeFileSync(join(dir, "test.ts"), 'const stripe = "sk_live_abcdefghijklmnopqrstuvwx";\n');
      const emitter = new SecdevEmitter({ cwd: dir, eventBus: bus });
      const result = await emitter.emit("t4", ["test.ts"]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.critical).toBeGreaterThanOrEqual(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
