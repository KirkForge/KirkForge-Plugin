import { ok } from "@55ndeep/core-types";
import type { Result } from "@55ndeep/core-types";
import type { EventBus } from "@55ndeep/core-events";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface EslintReport {
  taskId: string;
  errors: number;
  warnings: number;
  filesScanned: number;
  durationMs: number;
  details: Array<{
    file: string;
    line: number;
    rule: string;
    message: string;
    severity: "error" | "warning";
  }>;
}

/**
 * ESLint emitter — runs external ESLint and parses its JSON output.
 * This is the bridge between 55NDeep's verification pipeline and the
 * project's own ESLint configuration. It supplements the internal
 * regex-based lint engine with real AST-level linting.
 */
export class EslintEmitter {
  constructor(private opts: { cwd: string; eventBus?: EventBus; files?: string[] }) {}

  async emit(taskId: string): Promise<Result<EslintReport, Error>> {
    const start = Date.now();
    const { cwd, eventBus, files } = this.opts;

    // Find eslint binary
    const eslintBin = this.findEslintBin();
    if (!eslintBin) {
      const report: EslintReport = {
        taskId,
        errors: 0,
        warnings: 0,
        filesScanned: 0,
        durationMs: Date.now() - start,
        details: [],
      };
      await eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: {
          status: "skipped",
          errors: 0,
          warnings: 0,
          filesScanned: 0,
          durationMs: report.durationMs,
          details: [],
        },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    }

    const args = ["--format", "json", "--no-warn-ignored"];
    if (files && files.length > 0) {
      args.push(...files);
    } else {
      args.push("packages", "apps");
    }

    try {
      const { stdout, stderr } = await this.execAsync(eslintBin, args, cwd);
      const output = (stdout || "") + (stderr || "");

      // ESLint exits non-zero on lint errors, but still outputs JSON
      const details: EslintReport["details"] = [];
      let filesScanned = 0;

      try {
        const results = JSON.parse(output || "[]") as Array<{
          filePath: string;
          errorCount: number;
          warningCount: number;
          messages: Array<{ line: number; ruleId: string; message: string; severity: number }>;
        }>;
        for (const fileResult of results) {
          filesScanned++;
          for (const msg of fileResult.messages) {
            details.push({
              file: fileResult.filePath.replace(cwd + "/", ""),
              line: msg.line,
              rule: msg.ruleId || "unknown",
              message: msg.message,
              severity: msg.severity === 2 ? "error" : "warning",
            });
          }
        }
      } catch {
        // If JSON parse fails, include raw output as a single detail
        if (output.trim()) {
          details.push({
            file: "<eslint>",
            line: 0,
            rule: "eslint-parse-error",
            message: output.trim().slice(0, 500),
            severity: "error",
          });
        }
      }

      const errorCount = details.filter((d) => d.severity === "error").length;
      const warningCount = details.filter((d) => d.severity === "warning").length;

      const report: EslintReport = {
        taskId,
        errors: errorCount,
        warnings: warningCount,
        filesScanned,
        durationMs: Date.now() - start,
        details,
      };

      await eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: {
          status: errorCount > 0 ? "fail" : "pass",
          errors: errorCount,
          warnings: warningCount,
          filesScanned,
          durationMs: report.durationMs,
          details: details.slice(0, 500), // Cap to avoid event bloat
        },
        timestamp: new Date().toISOString(),
      });

      return ok(report);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const report: EslintReport = {
        taskId,
        errors: 1,
        warnings: 0,
        filesScanned: 0,
        durationMs: Date.now() - start,
        details: [
          { file: "<eslint>", line: 0, rule: "verifier-error", message, severity: "error" },
        ],
      };
      await eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: {
          status: "error",
          error: message,
          errors: 1,
          warnings: 0,
          filesScanned: 0,
          durationMs: report.durationMs,
          details: [],
        },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    }
  }

  private findEslintBin(): string | null {
    // Try local node_modules/.bin first
    const localBin = resolve(this.opts.cwd, "node_modules", ".bin", "eslint");
    if (existsSync(localBin)) return localBin;
    // Try global
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execFileSync } = require("node:child_process");
      const result = execFileSync("which", ["eslint"], { encoding: "utf-8" }).trim();
      if (result) return result;
    } catch {
      /* not found */
    }
    return null;
  }

  private execAsync(
    cmd: string,
    args: string[],
    cwd: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        cmd,
        args,
        { cwd, timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          // ESLint exits non-zero on lint errors — that's not a real error
          if (err && !stdout && !stderr) reject(err);
          else resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
        },
      );
    });
  }
}
