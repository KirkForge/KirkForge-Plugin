import { describe, it, expect } from "vitest";
import { TscEmitter } from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("TscEmitter", () => {
  it("constructs with cwd option", () => {
    const emitter = new TscEmitter({ cwd: process.cwd() });
    expect(emitter).toBeInstanceOf(TscEmitter);
  });

  it("returns skipped report when tsconfig.json is missing", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tsc-test-"));
    try {
      const emitter = new TscEmitter({ cwd: tmpDir });
      const result = await emitter.emit("test-task-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.errors).toBe(0);
        expect(result.value.details).toEqual([]);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes durationMs in report", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tsc-test-"));
    try {
      const emitter = new TscEmitter({ cwd: tmpDir });
      const result = await emitter.emit("test-task-duration");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns taskId in report", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "tsc-test-"));
    try {
      const emitter = new TscEmitter({ cwd: tmpDir });
      const result = await emitter.emit("my-custom-task-id");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.taskId).toBe("my-custom-task-id");
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
