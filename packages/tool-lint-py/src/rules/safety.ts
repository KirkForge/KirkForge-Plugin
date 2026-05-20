import type { LintRule } from "@55ndeep/tool-lint-core";

export const safetyRules: LintRule[] = [
  {
    id: "no-eval-exec",
    category: "safety",
    severity: "critical",
    pattern: /\b(?:eval|exec)\s*\(/g,
    message: "eval()/exec() is a security risk; never use it",
  },
  {
    id: "no-os-system",
    category: "safety",
    severity: "high",
    pattern: /\bos\.system\s*\(/g,
    message: "os.system() is unsafe; use subprocess.run() with shell=False",
  },
  {
    id: "no-subprocess-shell",
    category: "safety",
    severity: "high",
    pattern: /\bsubprocess\..*shell\s*=\s*True/g,
    message: "shell=True is a security risk; use with a list of arguments",
  },
  {
    id: "no-pickle",
    category: "safety",
    severity: "high",
    pattern: /\bpickle\.loads?\s*\(/g,
    message: "pickle is unsafe for untrusted data; use JSON or another safe serializer",
  },
  {
    id: "no-yaml-load",
    category: "safety",
    severity: "high",
    pattern: /\byaml\.load\s*\(/g,
    message: "yaml.load() is unsafe; use yaml.safe_load() instead",
  },
  {
    id: "no-request-verify-false",
    category: "safety",
    severity: "high",
    pattern: /\bverify\s*=\s*False/g,
    message: "SSL verification disabled; never disable cert verification in production",
  },
  {
    id: "no-hardcoded-password",
    category: "safety",
    severity: "high",
    pattern: /(?:password|passwd|secret|api_key|apikey|auth_token)\s*[:=]\s*['"][^'"]+['"]/gi,
    message: "Hardcoded credential; use environment variables or a secrets manager",
  },
  {
    id: "no-hardcoded-token",
    category: "safety",
    severity: "critical",
    pattern: /(?:sk-[a-zA-Z0-9_-]{20,}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{36,}|glpat-[a-zA-Z0-9_-]{20,}|xox[bprs]-[a-zA-Z0-9-]+)/g,
    message: "Hardcoded API token; use environment variables",
  },
];
