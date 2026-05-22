import type { LintRule } from "@55ndeep/tool-lint-core";

export const styleRules: LintRule[] = [
  {
    id: "no-var",
    category: "style",
    severity: "high",
    pattern: /\bvar\s+/g,
    message: "Use const or let instead of var",
  },
  {
    id: "no-any",
    category: "style",
    severity: "high",
    pattern: /:\s*any\b/g,
    message: "Avoid explicit any; use a specific type or unknown",
  },
  {
    id: "no-non-null-assert",
    category: "style",
    severity: "med",
    pattern: /\w+!\./g,
    message: "Avoid non-null assertions (!); use optional chaining or proper guards",
  },
  {
    id: "no-console",
    category: "style",
    severity: "med",
    pattern: /\bconsole\.(log|warn|error|debug|info|trace)\s*\(/g,
    message: "Remove console statement; use a proper logger",
  },
  {
    id: "no-debugger",
    category: "style",
    severity: "med",
    pattern: /\bdebugger\b/g,
    message: "Remove debugger statement",
  },
  {
    id: "no-alert",
    category: "style",
    severity: "med",
    pattern: /\b(alert|confirm|prompt)\s*\(/g,
    message: "Avoid browser-specific alert/confirm/prompt; use a proper UI",
  },
  {
    id: "max-params",
    category: "style",
    severity: "low",
    pattern: /(?:function\s+\w+|=>|\)\s*=>)\s*\([^)]*,[^)]*,[^)]*,[^)]*,[^)]*\)/g,
    message: "Function has too many parameters; consider an options object",
  },
  {
    id: "no-magic-numbers",
    category: "style",
    severity: "low",
    pattern:
      /(?<![a-zA-Z0-9_."'\`#])(?<!\bcase\s)(?<!\bconst\s+\w+\s*=\s*)(?<!\blet\s+\w+\s*=\s*)(?<!\bvar\s+\w+\s*=\s*)\b\d{4,}\b(?!['\"])/g,
    message: "Magic number detected; extract to a named constant",
  },
  {
    id: "no-unused-import",
    category: "correct",
    severity: "med",
    pattern: /^import\s+(?:type\s+)?(?:\{[^}]*\}|\w+)\s+from\s+['"][^'"]+['"]\s*;?\s*$/gm,
    message: "Potential unused import — verify this symbol is actually referenced in the file",
  },
];
