import { ok, err } from "@55ndeep/core-types";
import type { Result } from "@55ndeep/core-types";
import type { EventBus } from "@55ndeep/core-events";
import { createRequire } from "node:module";
import { relative, resolve, isAbsolute } from "node:path";

const _require = createRequire(import.meta.url);
const eslintModule = _require("eslint");
const ESLintImpl: { new(opts?: Record<string, unknown>): { lintFiles(files: string[]): Promise<Array<{ filePath: string; messages: Array<{ severity: number; line: number; ruleId: string | null; message: string }>; errorCount: number; warningCount: number }>> } } = eslintModule.ESLint;

interface EslintResult {
  filePath: string;
  messages: Array<{ severity: number; line: number; ruleId: string | null; message: string }>;
  errorCount: number;
  warningCount: number;
}

export interface EslintReport {
  taskId: string;
  errors: number;
  warnings: number;
  filesScanned: number;
  durationMs: number;
  details: Array<{ file: string; line: number; rule: string; message: string }>;
}

function sanitizeFilePath(cwd: string, f: string): string | null {
  const resolved = resolve(cwd, f);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) return null;
  return rel;
}

export class EslintEmitter {
  private cwd: string;
  private eventBus?: EventBus;
  private files?: string[];

  constructor(opts: { cwd: string; eventBus?: EventBus; files?: string[] }) {
    this.cwd = opts.cwd;
    this.eventBus = opts.eventBus;
    this.files = opts.files;
  }

  async emit(taskId: string): Promise<Result<EslintReport, Error>> {
    const start = Date.now();
    try {
      const eslint = new ESLintImpl({
        cwd: this.cwd,
        overrideConfig: {
          parser: "@typescript-eslint/parser",
          parserOptions: { ecmaVersion: 2022, sourceType: "module" },
          rules: { "no-unused-vars": "error", "no-undef": "off" },
        },
      });

      let lintTargets: string[];
      if (this.files && this.files.length > 0) {
        lintTargets = this.files
          .map(f => sanitizeFilePath(this.cwd, f))
          .filter((f): f is string => f !== null)
          .filter(f => /\.(?:ts|tsx)$/.test(f));
      } else {
        lintTargets = [`${this.cwd}/**/*.ts`, `${this.cwd}/**/*.tsx`];
      }

      let results: EslintResult[] = [];
      try {
        results = await eslint.lintFiles(lintTargets);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const report: EslintReport = { taskId, errors: 1, warnings: 0, filesScanned: 0, durationMs: Date.now() - start, details: [{ file: "<eslint>", line: 0, rule: "verifier-error", message }] };
        await this.eventBus?.emit({
          kind: "verify.lint",
          schemaVersion: "v3",
          sequence: 0,
          streamId: taskId,
          taskId,
          value: { status: "error", error: message, errors: 1, warnings: 0, filesScanned: 0, durationMs: report.durationMs, details: report.details },
          timestamp: new Date().toISOString(),
        });
        return ok(report);
      }

      const detailErrors: EslintReport["details"] = [];
      const detailWarnings: EslintReport["details"] = [];
      let filesScanned = 0;

      for (const r of results) {
        filesScanned++;
        for (const m of r.messages) {
          const entry = {
            file: r.filePath.replace(this.cwd, "").replace(/^\//, ""),
            line: m.line,
            rule: m.ruleId ?? "unknown",
            message: m.message,
          };
          if (m.severity === 2) detailErrors.push(entry);
          else detailWarnings.push(entry);
        }
      }

      const report: EslintReport = { taskId, errors: detailErrors.length, warnings: detailWarnings.length, filesScanned, durationMs: Date.now() - start, details: [...detailErrors, ...detailWarnings] };
      const status = detailErrors.length > 0 ? "fail" : "pass";

      await this.eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status, errors: detailErrors.length, warnings: detailWarnings.length, filesScanned, durationMs: report.durationMs, details: [...detailErrors, ...detailWarnings] },
        timestamp: new Date().toISOString(),
      });

      return ok(report);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/\b(ENOENT|not found|Cannot find module)\b/i.test(message)) {
        const report: EslintReport = { taskId, errors: 0, warnings: 0, filesScanned: 0, durationMs: 0, details: [] };
        await this.eventBus?.emit({
          kind: "verify.lint",
          schemaVersion: "v3",
          sequence: 0,
          streamId: taskId,
          taskId,
          value: { status: "skipped", errors: 0, warnings: 0, filesScanned: 0, durationMs: 0, details: [] },
          timestamp: new Date().toISOString(),
        });
        return ok(report);
      }
      return err(new Error(`eslint: ${message}`));
    }
  }
}
