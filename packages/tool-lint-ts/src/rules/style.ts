import type { LintRule } from "@55ndeep/tool-lint-core";

// 55ndeep-lint-disable no-var no-debugger
export const styleRules: LintRule[] = [
  {
    id: "no-var",
    category: "style",
    severity: "med",
    pattern: /\bvar\s+\w+\s*[=,;]/g,
    message: "Use const or let instead of var",
  },
  {
    id: "no-any",
    category: "style",
    severity: "info",
    pattern: /:\s*any\b/g,
    message: "Avoid explicit any; use a specific type or unknown",
  },
  {
    id: "no-console",
    category: "style",
    severity: "info",
    pattern: /\bconsole\.(log|warn|error|debug|info|trace)\s*\(/g,
    message: "Consider replacing console with a proper logger",
  },
  {
    id: "no-debugger",
    category: "style",
    severity: "high",
    pattern: /\bdebugger\b/g,
    message: "Remove debugger statement",
  },
  {
    id: "no-magic-numbers",
    category: "style",
    severity: "info",
    pattern:
      /(?<![a-zA-Z0-9_."'\`])(?<!\bcase\s)(?<!\bconst\s+\w+\s*=\s*)(?<!\blet\s+\w+\s*=\s*)(?<!\bvar\s+\w+\s*=\s*)\b\d{5,}\b(?!['"])/g,
    message: "Magic number detected; extract to a named constant",
  },
];
// 55ndeep-lint-enable no-var no-debugger
