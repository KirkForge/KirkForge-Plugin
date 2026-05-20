import type { LintRule } from "@55ndeep/tool-lint-core";

export const safetyRules: LintRule[] = [
  {
    id: "no-eval",
    category: "safety",
    severity: "critical",
    pattern: /\beval\s*\(/g,
    message: "eval() is a security risk; never use it",
  },
  {
    id: "no-implied-eval",
    category: "safety",
    severity: "high",
    pattern: /\b(setTimeout|setInterval)\s*\(\s*['\"\`]/g,
    message: "String argument to setTimeout/setInterval is implied eval; use a function reference",
  },
  {
    id: "no-new-func",
    category: "safety",
    severity: "high",
    pattern: /\bnew\s+Function\s*\(/g,
    message: "new Function() is a security risk; avoid dynamic code execution",
  },
  {
    id: "no-process-env",
    category: "safety",
    severity: "med",
    pattern: /\bprocess\.env\.\w+/g,
    message: "Direct process.env access; use a configuration layer or secrets service",
  },
  {
    id: "no-dynamic-require",
    category: "safety",
    severity: "med",
    pattern: /\brequire\s*\(\s*[^'\"]/g,
    message: "Dynamic require() with non-literal argument; use static imports",
  },
  {
    id: "no-unsafe-regex",
    category: "safety",
    severity: "med",
    pattern: /\(\w+\+\)\+/g,
    message: "Potentially unsafe regex (ReDoS risk); simplify or add length limits",
  },
  {
    id: "no-assign-in-cond",
    category: "safety",
    severity: "med",
    pattern: /\bif\s*\(\s*\w+\s*=\s*[^=]/g,
    message: "Assignment in condition; did you mean === ?",
  },
];
