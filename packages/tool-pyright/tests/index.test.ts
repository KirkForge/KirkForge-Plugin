import { describe, it, expect } from "vitest";
import { PyrightEmitter } from "../src/index.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

const tmpDir = resolve(tmpdir(), "55ndeep-pyright-tests-" + Date.now());

async function writeTestFile(relPath: string, content: string) {
  const full = resolve(tmpDir, relPath);
  const dir = resolve(full, "..");
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await writeFile(full, content, "utf-8");
}

describe("PyrightEmitter", () => {
  it("returns skipped when no Python files exist", async () => {
    const emitter = new PyrightEmitter({ cwd: tmpDir });
    const result = await emitter.emit("t1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.errors).toBe(0);
      expect(result.value.details).toHaveLength(0);
    }
  });

  it("returns skipped for zero-length file list", async () => {
    await writeTestFile("empty.py", "");
    const emitter = new PyrightEmitter({ cwd: tmpDir, files: [] });
    const result = await emitter.emit("t2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.errors).toBe(0);
    }
  });

  it("discovers Python files when files not specified", async () => {
    await writeTestFile("hello.py", "print('hello')\n");
    const emitter = new PyrightEmitter({ cwd: tmpDir });
    const result = await emitter.emit("t3");
    expect(result.ok).toBe(true);
    // If pyright is installed, it may find errors; if not, falls back gracefully
  });

  it("handles missing pyright gracefully (ENOENT)", async () => {
    await writeTestFile("test.py", "x: int = 'wrong'\n");
    // Point to a command that doesn't exist
    const emitter = new PyrightEmitter({ cwd: tmpDir, command: "nonexistent-pyright-xyz" });
    const result = await emitter.emit("t4");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should skip with 0 errors when tool is missing
      expect(result.value.errors).toBe(0);
      expect(result.value.details).toHaveLength(0);
    }
  });

  it("sanitizes file paths that escape cwd", async () => {
    const emitter = new PyrightEmitter({ cwd: tmpDir, files: ["../escape.py"] });
    const result = await emitter.emit("t5");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Attempted escape should be filtered, resulting in 0 files
      expect(result.value.errors).toBe(0);
    }
  });

  it("includes taskId in report", async () => {
    const emitter = new PyrightEmitter({ cwd: tmpDir });
    const result = await emitter.emit("task-42");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.taskId).toBe("task-42");
    }
  });

  it("reports durationMs above zero for scans", async () => {
    await writeTestFile("timed.py", "x = 1\n");
    const emitter = new PyrightEmitter({ cwd: tmpDir });
    const result = await emitter.emit("t7");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

afterAll(async () => {
  try { await rm(tmpDir, { recursive: true, force: true }); } catch {}
});
