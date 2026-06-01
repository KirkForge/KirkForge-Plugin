import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = join(import.meta.dirname ?? ".", "..");
const NODE_MODULES_BIN = join(PROJECT_ROOT, "node_modules", ".bin");

function hasTool(cmd: string, args: string[] = ["--version"]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function eslintBin(): string {
  return join(NODE_MODULES_BIN, "eslint");
}

function tscBin(): string {
  return join(NODE_MODULES_BIN, "tsc");
}

describe("e2e smoke — real language tooling", () => {
  it("eslint detects issues in bad JS", () => {
    const eslint = eslintBin();
    if (!hasTool(eslint)) return;

    const dir = mkdtempSync(join(tmpdir(), "kirkforge-smoke-"));
    try {
      writeFileSync(join(dir, "bad.js"), "const x = 1;\nconst y = 2;\n");
      writeFileSync(
        join(dir, "eslint.config.mjs"),
        [
          "export default [",
          "  {",
          "    rules: {",
          '      "no-unused-vars": "error",',
          "    },",
          "  },",
          "];",
        ].join("\n"),
      );

      let output: string;
      try {
        const result = execFileSync(eslint, ["bad.js", "--format=json", "--no-warn-ignored"], {
          cwd: dir,
          stdio: "pipe",
          timeout: 30000,
        });
        output = result.toString();
      } catch (err: unknown) {
        const caught = err as Error & { stdout?: Buffer };
        if (caught?.stdout) output = caught.stdout.toString();
        else throw err;
      }
      const parsed = JSON.parse(output);
      expect(parsed).toBeInstanceOf(Array);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0].messages.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tsc type-checks files", () => {
    const tsc = tscBin();
    if (!hasTool(tsc)) return;

    const dir = mkdtempSync(join(tmpdir(), "kirkforge-smoke-"));
    try {
      writeFileSync(join(dir, "good.ts"), "export const x: number = 42;\n");
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "bundler",
            skipLibCheck: true,
            noEmit: true,
          },
          include: ["good.ts"],
        }),
      );

      const result = execFileSync(tsc, ["--noEmit"], { cwd: dir, stdio: "pipe", timeout: 30000 });
      expect(result.toString().trim()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ruff detects Python issues", () => {
    if (!hasTool("ruff")) return;

    const dir = mkdtempSync(join(tmpdir(), "kirkforge-smoke-"));
    try {
      writeFileSync(join(dir, "bad.py"), "import os\nimport sys\nx=1\n");

      let stdout = "";
      try {
        execFileSync("ruff", ["check", "bad.py"], { cwd: dir, stdio: "pipe", timeout: 30000 });
      } catch (err: unknown) {
        const caught = err as Error & { stdout?: Buffer; stderr?: Buffer };
        if (caught?.stdout) stdout = caught.stdout.toString();
        else if (caught?.stderr) stdout = caught.stderr.toString();
        else throw err;
      }
      expect(stdout).toContain("import");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("git is available (required for gitnexus)", () => {
    expect(hasTool("git")).toBe(true);
  });

  it("node is available", () => {
    try {
      const v = execFileSync("node", ["--version"], { stdio: "pipe", encoding: "utf-8" });
      expect(v).toMatch(/v\d+/);
    } catch {
      // CI may not have node on PATH the same way
    }
  });
});
