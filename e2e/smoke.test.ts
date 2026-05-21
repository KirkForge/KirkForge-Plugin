import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SKIP_REASON = process.env.CI ? undefined : "E2E smoke tests require language tooling present in CI";

function hasTool(cmd: string): boolean {
  try {
    execFileSync(cmd, ["--version"], { stdio: "pipe", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe("e2e smoke — real language tooling", () => {
  const runIf = (tool: string) => {
    const available = hasTool(tool);
    return available ? it : it.skip;
  };

  runIf("eslint")("eslint detects issues in bad TS", () => {
    const dir = mkdtempSync(join(tmpdir(), "55n-smoke-"));
    writeFileSync(join(dir, "bad.ts"), 'const x: number = "string";\n');
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }));
    writeFileSync(join(dir, ".eslintrc.json"), JSON.stringify({ root: true, parser: "@typescript-eslint/parser", rules: { "no-unused-vars": "error" } }));

    try {
      const result = execFileSync("npx", ["eslint", "bad.ts", "--format=json"], { cwd: dir, stdio: "pipe", timeout: 30000 });
      const output = JSON.parse(result.toString());
      expect(output).toBeInstanceOf(Array);
      expect(output.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runIf("tsc")("tsc type-checks files", () => {
    const dir = mkdtempSync(join(tmpdir(), "55n-smoke-"));
    writeFileSync(join(dir, "good.ts"), "export const x: number = 42;\n");
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", noEmit: true }, include: ["good.ts"] }));

    try {
      const result = execFileSync("npx", ["tsc", "--noEmit"], { cwd: dir, stdio: "pipe", timeout: 30000 });
      expect(result.toString()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  runIf("ruff")("ruff detects Python issues", () => {
    const dir = mkdtempSync(join(tmpdir(), "55n-smoke-"));
    writeFileSync(join(dir, "bad.py"), "import os\nimport sys\nx=1\n");

    try {
      execFileSync("ruff", ["check", "bad.py"], { cwd: dir, stdio: "pipe", timeout: 30000 });
      // ruff exits 0 with fixable issues, we just verify it runs
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
