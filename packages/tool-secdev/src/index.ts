import { ok, err } from "@55ndeep/core-types";
import type { Result } from "@55ndeep/core-types";
import type { EventBus } from "@55ndeep/core-events";
import { walkFiles } from "@55ndeep/core-logging";
import { readFile } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";

interface Finding {
  file: string;
  line: number;
  rule: string;
  severity: "high" | "critical" | "med" | "low";
  message: string;
}

const RULES: Array<{ name: string; severity: Finding["severity"]; pattern: RegExp; message: string }> = [
  { name: "hardcoded-aws-key", severity: "high", pattern: /AKIA[0-9A-Z]{16}/g, message: "Hardcoded AWS access key" },
  { name: "hardcoded-openai-key", severity: "critical", pattern: /sk-[a-zA-Z0-9_-]{20,}/g, message: "Hardcoded OpenAI API key" },
  { name: "hardcoded-gh-token", severity: "high", pattern: /ghp_[a-zA-Z0-9]{36}/g, message: "Hardcoded GitHub PAT" },
  { name: "hardcoded-gh-new", severity: "high", pattern: /github_pat_[a-zA-Z0-9_]{36,}/g, message: "Hardcoded GitHub fine-grained PAT" },
  { name: "hardcoded-gitlab-token", severity: "high", pattern: /glpat-[a-zA-Z0-9_-]{20,}/g, message: "Hardcoded GitLab PAT" },
  { name: "hardcoded-stripe-live", severity: "critical", pattern: /sk_live_[a-zA-Z0-9]{24,}/g, message: "Hardcoded Stripe live secret key" },
  { name: "hardcoded-stripe-test", severity: "med", pattern: /sk_test_[a-zA-Z0-9]{24,}/g, message: "Hardcoded Stripe test key" },
  { name: "hardcoded-slack-token", severity: "high", pattern: /xox[bprs]-[a-zA-Z0-9-]+/g, message: "Hardcoded Slack token" },
  { name: "hardcoded-jwt", severity: "med", pattern: /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, message: "Hardcoded JWT" },
  { name: "eval-usage", severity: "critical", pattern: /\beval\s*\(/g, message: "eval() call detected" },
  { name: "unsafe-function", severity: "med", pattern: /new\s+Function\s*\(/g, message: "new Function() detected" },
  { name: "shell-exec", severity: "high", pattern: /exec\s*\(\s*['"`][^'"]*\${?[^}]*}?[^'"]*['"`]\s*[,)]/g, message: "Potential shell injection" },
  { name: "sql-inject", severity: "critical", pattern: /`\s*(?:SELECT|INSERT|UPDATE|DELETE)\s+.*\$\{/gi, message: "Potential SQL injection via template literal" },
  { name: "http-url", severity: "low", pattern: /http:\/\/[^\s'"]+/g, message: "HTTP (not HTTPS) URL" },
];

const SCANNABLE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".sh", ".bash", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp",
  ".go", ".rs", ".sql",
]);

function isScannableFile(filePath: string): boolean {
  const ext = filePath.lastIndexOf(".");
  if (ext === -1) return false;
  return SCANNABLE_EXTENSIONS.has(filePath.slice(ext).toLowerCase());
}

function sanitizeFilePath(cwd: string, f: string): string | null {
  const resolved = resolve(cwd, f);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) return null;
  return rel;
}


export interface SecdevReport {
  taskId: string;
  findings: number;
  critical: number;
  high: number;
  filesScanned: number;
  durationMs: number;
  details: Array<{ file: string; line: number; rule: string; severity: string; message: string }>;
}

export class SecdevEmitter {
  constructor(private opts: { cwd: string; eventBus?: EventBus }) {}

  async emit(taskId: string, files?: string[]): Promise<Result<SecdevReport, Error>> {
    const start = Date.now();
    const { cwd, eventBus } = this.opts;
    const allFindings: Finding[] = [];
    let filesScanned = 0;
    let targets: string[];

    if (files && files.length > 0) {
      targets = files
        .map(f => sanitizeFilePath(cwd, f))
        .filter((f): f is string => f !== null);
    } else {
      targets = [];
    }

    if (targets.length === 0) {
      try {
        targets = await walkFiles(cwd, isScannableFile);
      } catch {}
    }

    for (const f of targets) {
      if (!isScannableFile(f)) continue;
      try {
        const content = await readFile(resolve(cwd, f), "utf-8");
        const rel = relative(cwd, resolve(cwd, f));
        filesScanned++;
        for (const rule of RULES) {
          rule.pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = rule.pattern.exec(content)) !== null) {
            const line = content.slice(0, m.index).split("\n").length;
            allFindings.push({ file: rel, line, rule: rule.name, severity: rule.severity, message: rule.message });
          }
        }
      } catch {}
    }

    const critical = allFindings.filter(f => f.severity === "critical").length;
    const high = allFindings.filter(f => f.severity === "high").length;
    const report: SecdevReport = { taskId, findings: allFindings.length, critical, high, filesScanned, durationMs: Date.now() - start, details: allFindings.map(f => ({ file: f.file, line: f.line, rule: f.rule, severity: f.severity, message: f.message })) };
    const status = critical > 0 || high > 0 ? "fail" : "pass";

    await eventBus?.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 0,
      streamId: taskId,
      taskId,
      value: { status, findings: allFindings.length, critical, high, filesScanned, durationMs: report.durationMs, details: allFindings.map(f => ({ file: f.file, line: f.line, rule: f.rule, severity: f.severity, message: f.message })) },
      timestamp: new Date().toISOString(),
    });

    return ok(report);
  }
}
