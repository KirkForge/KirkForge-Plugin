import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { ok, err } from "@55ndeep/core-types";
import type { Result } from "@55ndeep/core-types";
import type { EventBus } from "@55ndeep/core-events";
import { walkFiles } from "@55ndeep/core-logging";
import type { LintRule, LintFinding, LintResult } from "./rules.js";
import { RuleRegistry } from "./rules.js";

const SCANNABLE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
]);
const MAX_LINES = 200;

export interface LintEngineOptions {
  cwd: string;
  eventBus?: EventBus;
  files?: string[];
  extensions?: Set<string>;
}

export interface LintReport {
  source: string;
  status: "pass" | "fail" | "skipped" | "error";
  errors: number;
  warnings: number;
  filesScanned: number;
  durationMs: number;
  details: Array<{ file: string; line: number; rule: string; message: string }>;
}

export class LintEngine {
  private registry: RuleRegistry;
  private cwd: string;
  private eventBus?: EventBus;
  private files?: string[];
  private extensions: Set<string>;

  constructor(opts: LintEngineOptions) {
    this.registry = new RuleRegistry();
    this.cwd = resolve(opts.cwd);
    this.eventBus = opts.eventBus;
    this.files = opts.files;
    this.extensions = opts.extensions ?? SCANNABLE_EXTS;
  }

  addRule(rule: LintRule): void {
    this.registry.addRule(rule);
  }

  addRules(rules: LintRule[]): void {
    this.registry.addRules(rules);
  }

  async emit(taskId: string): Promise<Result<LintReport, Error>> {
    const startedAt = Date.now();
    try {
      const rules = this.registry.getRules();
      const findings: LintFinding[] = [];

      const includeFilter = (rel: string): boolean => {
        const ext = rel.slice(rel.lastIndexOf("."));
        return this.extensions.has(ext);
      };

      const allFiles: string[] = this.files
        ? this.files.filter(f => this.extensions.has(f.slice(f.lastIndexOf(".")))).map(f => relative(this.cwd, resolve(this.cwd, f)))
        : await walkFiles(this.cwd, includeFilter);

      for (const relPath of allFiles) {
        const filePath = resolve(this.cwd, relPath);
        try {
          const content = await readFile(filePath, "utf-8");
          const lines = content.split("\n");

          // File-level checks
          const ext = relPath.slice(relPath.lastIndexOf("."));
          const isShell = [".sh", ".bash", ".zsh"].includes(ext);
          if (isShell && !content.startsWith("#!")) {
            findings.push({
              file: relPath,
              line: 1,
              rule: "require-shebang",
              category: "style",
              severity: "med",
              message: "Script missing shebang; add #!/bin/bash or similar",
            });
          }
          if (lines.length > MAX_LINES) {
            findings.push({
              file: relPath,
              line: MAX_LINES + 1,
              rule: "max-lines",
              category: "style",
              severity: "info",
              message: `File has ${lines.length} lines; maximum is ${MAX_LINES}`,
            });
          }

          for (const rule of rules) {
            const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i]!;
              if (pattern.test(line)) {
                findings.push({
                  file: relPath,
                  line: i + 1,
                  rule: rule.id,
                  category: rule.category,
                  severity: rule.severity,
                  message: rule.message,
                });
              }
            }
          }
        } catch {
          // Skip unreadable files
        }
      }

      const errorFindings = findings.filter(f => f.severity === "critical" || f.severity === "high" || f.severity === "med");
      const warningFindings = findings.filter(f => f.severity === "low" || f.severity === "info");

      const report: LintReport = {
        source: taskId,
        status: errorFindings.length > 0 ? "fail" : "pass",
        errors: errorFindings.length,
        warnings: warningFindings.length,
        filesScanned: allFiles.length,
        durationMs: Date.now() - startedAt,
        details: [...errorFindings, ...warningFindings].map(f => ({
          file: f.file,
          line: f.line,
          rule: f.rule,
          message: f.message,
        })),
      };

      // Emit verify.lint
      await this.eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: {
          status: report.status,
          errors: report.errors,
          warnings: report.warnings,
          filesScanned: report.filesScanned,
          durationMs: report.durationMs,
          details: report.details,
        },
        timestamp: new Date().toISOString(),
      });

      // Emit verify.security from safety-category findings
      const safetyFindings = findings.filter(f => f.category === "safety");
      const secCritical = safetyFindings.filter(f => f.severity === "critical").length;
      const secHigh = safetyFindings.filter(f => f.severity === "high").length;
      const secStatus = secCritical > 0 || secHigh > 0 ? "fail" : "pass";

      await this.eventBus?.emit({
        kind: "verify.security",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: {
          status: secStatus,
          findings: safetyFindings.length,
          critical: secCritical,
          high: secHigh,
          filesScanned: allFiles.length,
          durationMs: report.durationMs,
          details: safetyFindings.map(f => ({
            file: f.file,
            line: f.line,
            rule: f.rule,
            severity: f.severity,
            message: f.message,
          })),
        },
        timestamp: new Date().toISOString(),
      });

      return ok(report);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const report: LintReport = { source: taskId, status: "error", errors: 1, warnings: 0, filesScanned: 0, durationMs: Date.now() - startedAt, details: [{ file: "<lint-engine>", line: 0, rule: "verifier-error", message }] };
      await this.eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: { status: "error", error: message, errors: 1, warnings: 0, filesScanned: 0, durationMs: report.durationMs, details: report.details },
        timestamp: new Date().toISOString(),
      });
      await this.eventBus?.emit({
        kind: "verify.security",
        schemaVersion: "v3",
        sequence: Date.now(),
        streamId: taskId,
        taskId,
        value: { status: "error", error: message, findings: 1, critical: 1, high: 0, filesScanned: 0, durationMs: report.durationMs, details: [] },
        timestamp: new Date().toISOString(),
      });
      return err(new Error(`55ndeep-lint: ${message}`));
    }
  }
}
