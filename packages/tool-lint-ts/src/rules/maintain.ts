import type { LintRule } from "@55ndeep/tool-lint-core";

export const maintainRules: LintRule[] = [
  {
    id: "no-todo-fixme",
    category: "maintain",
    severity: "info",
    pattern: /\/\/\s*(?:TODO|FIXME|HACK|XXX)\b/gi,
    message: "TODO/FIXME comment; address or convert to a ticket",
  },
  {
    id: "no-dead-code",
    category: "maintain",
    severity: "low",
    pattern: /^\s*\/\/\s*[\w\s,;(){}\[\].<>=!&|+\-*\/]{30,}$/gm,
    message: "Potentially commented-out code block; remove if unused",
  },
  {
    id: "require-jsdoc",
    category: "maintain",
    severity: "low",
    pattern: /^export\s+(?:async\s+)?function\s+\w+(?![^{]*\/\*\*)/gm,
    message: "Exported function missing JSDoc comment",
  },
];
