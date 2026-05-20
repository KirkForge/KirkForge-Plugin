import { execFile } from "node:child_process";
import { relative, resolve, isAbsolute } from "node:path";
import { ok } from "@55ndeep/core-types";
import type { Result } from "@55ndeep/core-types";
import type { EventBus } from "@55ndeep/core-events";
import { walkFiles } from "@55ndeep/core-logging";

interface PythonToolOpts {
  cwd: string;
  eventBus?: EventBus;
  files?: string[];
  command?: string;
}

export interface PythonLintReport {
  taskId: string;
  errors: number;
  warnings: number;
  filesScanned: number;
  durationMs: number;
  details: Array<{ file: string; line: number; rule: string; message: string }>;
}

export interface PythonTypesReport {
  taskId: string;
  errors: number;
  durationMs: number;
  details: Array<{ file: string; line: number; code: string; message: string }>;
}

export interface PythonSecurityReport {
  taskId: string;
  findings: number;
  critical: number;
  high: number;
  filesScanned: number;
  durationMs: number;
  details: Array<{ file: string; line: number; rule: string; severity: string; message: string }>;
}

type ExecResult = { stdout: string; stderr: string };

function runTool(cmd: string, args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = stdout?.toString?.() ?? "";
      const errOut = stderr?.toString?.() ?? "";
      if (err && !out && !errOut) reject(err);
      else resolve({ stdout: out, stderr: errOut });
    });
  });
}

function isPythonFile(file: string): boolean {
  return file.endsWith(".py");
}

function sanitizeFilePath(cwd: string, f: string): string | null {
  const resolved = resolve(cwd, f);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) return null;
  return rel;
}

async function discoverPythonFiles(cwd: string, files?: string[]): Promise<string[]> {
  if (files && files.length > 0) {
    return files
      .map(f => sanitizeFilePath(cwd, f))
      .filter((f): f is string => f !== null)
      .filter(isPythonFile);
  }

  return walkFiles(cwd, (entry) => entry.endsWith(".py"));
}


function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isMissingTool(e: unknown, cmd: string): boolean {
  const msg = errorMessage(e);
  return /\b(ENOENT|not found|spawn\b.*\bENOENT)\b/i.test(msg) || msg.includes(`spawn ${cmd} ENOENT`);
}

export class RuffEmitter {
  constructor(private opts: PythonToolOpts) {}

  async emit(taskId: string): Promise<Result<PythonLintReport, Error>> {
    const start = Date.now();
    const { cwd, eventBus } = this.opts;
    const targets = await discoverPythonFiles(cwd, this.opts.files);

    if (targets.length === 0) {
      const report: PythonLintReport = { taskId, errors: 0, warnings: 0, filesScanned: 0, durationMs: 0, details: [] };
      await eventBus?.emit({
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

    try {
      const { stdout, stderr } = await runTool(this.opts.command ?? "ruff", ["check", "--output-format=json", ...targets], cwd);
      let parsed: Array<{ filename?: string; location?: { row?: number }; code?: string; message?: string }>;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : [];
      } catch {
        throw new Error((stderr || stdout || "ruff returned unparseable output").trim().slice(0, 500));
      }

      const details = parsed.map((finding) => ({
        file: relative(cwd, resolve(cwd, finding.filename ?? "<ruff>")),
        line: finding.location?.row ?? 0,
        rule: finding.code ?? "ruff",
        message: finding.message ?? "ruff finding",
      }));
      const report: PythonLintReport = { taskId, errors: details.length, warnings: 0, filesScanned: targets.length, durationMs: Date.now() - start, details };
      await eventBus?.emit({
        kind: "verify.lint",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: details.length > 0 ? "fail" : "pass", errors: details.length, warnings: 0, filesScanned: targets.length, durationMs: report.durationMs, details },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    } catch (e) {
      const message = errorMessage(e);
      if (isMissingTool(e, this.opts.command ?? "ruff")) {
        const report: PythonLintReport = { taskId, errors: 0, warnings: 0, filesScanned: 0, durationMs: 0, details: [] };
        await eventBus?.emit({
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
      const report: PythonLintReport = { taskId, errors: 1, warnings: 0, filesScanned: 0, durationMs: Date.now() - start, details: [{ file: "<ruff>", line: 0, rule: "VERIFIER_ERROR", message }] };
      await eventBus?.emit({
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
  }
}

export class PyrightEmitter {
  constructor(private opts: PythonToolOpts) {}

  async emit(taskId: string): Promise<Result<PythonTypesReport, Error>> {
    const start = Date.now();
    const { cwd, eventBus } = this.opts;
    const targets = await discoverPythonFiles(cwd, this.opts.files);

    if (targets.length === 0) {
      const report: PythonTypesReport = { taskId, errors: 0, durationMs: 0, details: [] };
      await eventBus?.emit({
        kind: "verify.types",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: "skipped", errors: 0, durationMs: 0, details: [] },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    }

    try {
      const { stdout, stderr } = await runTool(this.opts.command ?? "pyright", ["--outputjson", ...targets], cwd);
      let parsed: { summary?: { errorCount?: number }; diagnostics?: Array<{ file?: { path?: string }; range?: { start?: { line?: number } }; code?: string; message?: string }> };
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : {};
      } catch {
        throw new Error((stderr || stdout || "pyright returned unparseable output").trim().slice(0, 500));
      }

      const errors = parsed.summary?.errorCount ?? 0;
      const details = (parsed.diagnostics ?? []).map((d) => ({
        file: relative(cwd, resolve(cwd, d.file?.path ?? "<pyright>")),
        line: (d.range?.start?.line ?? 0) + 1,
        code: d.code ?? "pyright",
        message: d.message ?? "pyright error",
      }));
      const report: PythonTypesReport = { taskId, errors, durationMs: Date.now() - start, details };
      await eventBus?.emit({
        kind: "verify.types",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: errors > 0 ? "fail" : "pass", errors, durationMs: report.durationMs, details },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    } catch (e) {
      const message = errorMessage(e);
      if (isMissingTool(e, this.opts.command ?? "pyright")) {
        const report: PythonTypesReport = { taskId, errors: 0, durationMs: 0, details: [] };
        await eventBus?.emit({
          kind: "verify.types",
          schemaVersion: "v3",
          sequence: 0,
          streamId: taskId,
          taskId,
          value: { status: "skipped", errors: 0, durationMs: 0, details: [] },
          timestamp: new Date().toISOString(),
        });
        return ok(report);
      }
      const report: PythonTypesReport = { taskId, errors: 1, durationMs: Date.now() - start, details: [{ file: "<pyright>", line: 0, code: "VERIFIER_ERROR", message }] };
      await eventBus?.emit({
        kind: "verify.types",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: "error", error: message, errors: 1, durationMs: report.durationMs, details: report.details },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    }
  }
}

export class BanditEmitter {
  constructor(private opts: PythonToolOpts) {}

  async emit(taskId: string, files?: string[]): Promise<Result<PythonSecurityReport, Error>> {
    const start = Date.now();
    const { cwd, eventBus } = this.opts;
    const targets = await discoverPythonFiles(cwd, files ?? this.opts.files);

    if (targets.length === 0) {
      const report: PythonSecurityReport = { taskId, findings: 0, critical: 0, high: 0, filesScanned: 0, durationMs: 0, details: [] };
      await eventBus?.emit({
        kind: "verify.security",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: "skipped", findings: 0, critical: 0, high: 0, filesScanned: 0, durationMs: 0, details: [] },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    }

    try {
      const { stdout, stderr } = await runTool(this.opts.command ?? "bandit", ["-f", "json", "-q", ...targets], cwd);
      let parsed: { results?: Array<{ filename?: string; line_number?: number; test_id?: string; issue_severity?: string; issue_text?: string }> };
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : {};
      } catch {
        throw new Error((stderr || stdout || "bandit returned unparseable output").trim().slice(0, 500));
      }

      const details = (parsed.results ?? []).map((finding) => {
        const severity = (finding.issue_severity ?? "low").toLowerCase();
        return {
          file: relative(cwd, resolve(cwd, finding.filename ?? "<bandit>")),
          line: finding.line_number ?? 0,
          rule: finding.test_id ?? "bandit",
          severity,
          message: finding.issue_text ?? "bandit finding",
        };
      });
      const high = details.filter((finding) => finding.severity === "high").length;
      const critical = details.filter((finding) => finding.severity === "critical").length;
      const report: PythonSecurityReport = { taskId, findings: details.length, critical, high, filesScanned: targets.length, durationMs: Date.now() - start, details };
      await eventBus?.emit({
        kind: "verify.security",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: critical > 0 || high > 0 ? "fail" : "pass", findings: details.length, critical, high, filesScanned: targets.length, durationMs: report.durationMs, details },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    } catch (e) {
      const message = errorMessage(e);
      if (isMissingTool(e, this.opts.command ?? "bandit")) {
        const report: PythonSecurityReport = { taskId, findings: 0, critical: 0, high: 0, filesScanned: 0, durationMs: 0, details: [] };
        await eventBus?.emit({
          kind: "verify.security",
          schemaVersion: "v3",
          sequence: 0,
          streamId: taskId,
          taskId,
          value: { status: "skipped", findings: 0, critical: 0, high: 0, filesScanned: 0, durationMs: 0, details: [] },
          timestamp: new Date().toISOString(),
        });
        return ok(report);
      }
      const report: PythonSecurityReport = { taskId, findings: 1, critical: 1, high: 0, filesScanned: 0, durationMs: Date.now() - start, details: [{ file: "<bandit>", line: 0, rule: "verifier-error", severity: "critical", message }] };
      await eventBus?.emit({
        kind: "verify.security",
        schemaVersion: "v3",
        sequence: 0,
        streamId: taskId,
        taskId,
        value: { status: "error", error: message, findings: 1, critical: 1, high: 0, filesScanned: 0, durationMs: report.durationMs, details: report.details },
        timestamp: new Date().toISOString(),
      });
      return ok(report);
    }
  }
}
