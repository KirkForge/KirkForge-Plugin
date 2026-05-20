import { LintEngine } from "@55ndeep/tool-lint-core";
import type { LintEngineOptions, LintReport } from "@55ndeep/tool-lint-core";
import type { LintRule } from "@55ndeep/tool-lint-core";

const C_EXTS = new Set([".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx"]);

const cRules: LintRule[] = [
  { id: "no-gets", category: "safety", severity: "critical", pattern: /\bgets\s*\(/g, message: "gets() is unsafe; use fgets() instead" },
  { id: "no-strcpy", category: "safety", severity: "high", pattern: /\bstrcpy\s*\(/g, message: "strcpy() is unsafe; use strncpy() or safer alternative" },
  { id: "no-sprintf", category: "safety", severity: "high", pattern: /\bsprintf\s*\(/g, message: "sprintf() is unsafe; use snprintf() instead" },
  { id: "no-system", category: "safety", severity: "high", pattern: /\bsystem\s*\(/g, message: "system() is unsafe; avoid shelling out" },
  { id: "no-malloc-cast", category: "style", severity: "med", pattern: /\(\w+\*\)\s*malloc\s*\(/g, message: "Don't cast malloc return value; void* auto-coerces in C" },
  { id: "no-void-main", category: "correct", severity: "med", pattern: /\bvoid\s+main\s*\(/g, message: "Use int main(void); void main is non-standard" },
  { id: "no-missing-include-guard", category: "correct", severity: "med", pattern: /^(?!.*#ifndef.*\n.*#define)/g, message: "Header missing include guard" },
  { id: "no-ternary-nest", category: "style", severity: "low", pattern: /\?\s*[^:]+:\s*[^;]*\?/g, message: "Nested ternary operator; use if/else for clarity" },
  { id: "no-goto", category: "style", severity: "med", pattern: /\bgoto\s+\w+/g, message: "goto is discouraged; use structured control flow" },
  { id: "no-magic-numbers", category: "style", severity: "low", pattern: /(?<!0x)(?<!\w)\d{4,}(?!\w)/g, message: "Magic number; extract to a named constant or #define" },
];

export function createCLintEngine(opts: LintEngineOptions): LintEngine {
  const engine = new LintEngine({ ...opts, extensions: C_EXTS });
  engine.addRules(cRules);
  return engine;
}

export { LintEngine }; export type { LintEngineOptions, LintReport };
