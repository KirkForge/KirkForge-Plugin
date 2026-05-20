import { LintEngine } from "@55ndeep/tool-lint-core";
import type { LintEngineOptions, LintReport } from "@55ndeep/tool-lint-core";
import type { LintRule } from "@55ndeep/tool-lint-core";

const GO_EXTS = new Set([".go"]);

const goRules: LintRule[] = [
  { id: "no-naked-return", category: "style", severity: "med", pattern: /\breturn\s*$(?=\s*\S)/gm, message: "Naked return in named-return function; be explicit" },
  { id: "no-panic", category: "safety", severity: "high", pattern: /\bpanic\s*\(/g, message: "panic() should be avoided in production; return errors instead" },
  { id: "no-global-var", category: "style", severity: "med", pattern: /^var\s+\w+\s+[^(\n]+$(?!.*\bfunc\b)/gm, message: "Package-level mutable global; consider dependency injection" },
  { id: "no-unhandled-error", category: "correct", severity: "high", pattern: /\b\w+,\s*_\s*:?=\s*\w+/g, message: "Unhandled error with blank identifier; check and handle" },
  { id: "no-defer-in-loop", category: "perf", severity: "med", pattern: /for\s+.*\{[\s\S]*?\bdefer\b/g, message: "defer in loop defers until function exit; wrap in closure" },
  { id: "no-string-title", category: "style", severity: "low", pattern: /\bstrings\.Title\s*\(/g, message: "strings.Title is deprecated; use golang.org/x/text/cases instead" },
  { id: "no-init-side-effect", category: "maintain", severity: "med", pattern: /^func\s+init\s*\(\s*\)\s*\{[\s\S]*?\b(?!return)/gm, message: "init() with side effects; prefer explicit initialization" },
];

export function createGoLintEngine(opts: LintEngineOptions): LintEngine {
  const engine = new LintEngine({ ...opts, extensions: GO_EXTS });
  engine.addRules(goRules);
  return engine;
}

export { LintEngine }; export type { LintEngineOptions, LintReport };
