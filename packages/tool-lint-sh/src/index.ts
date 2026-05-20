import { LintEngine } from "@55ndeep/tool-lint-core";
import type { LintEngineOptions, LintReport } from "@55ndeep/tool-lint-core";
import type { LintRule } from "@55ndeep/tool-lint-core";

const SH_EXTS = new Set([".sh", ".bash", ".zsh"]);

const shellRules: LintRule[] = [
  { id: "no-unquoted-vars", category: "safety", severity: "high", pattern: /\$\{?\w+\}?(?![^"]*")/g, message: "Unquoted variable expansion; always quote variables" },
  { id: "no-backticks", category: "safety", severity: "med", pattern: /`[^`]+`/g, message: "Use $() instead of backticks for command substitution" },
  { id: "no-eval", category: "safety", severity: "critical", pattern: /\beval\s+/g, message: "eval is dangerous; never use it" },
  { id: "no-sudo", category: "safety", severity: "med", pattern: /\bsudo\s+/g, message: "Avoid sudo in scripts; run with appropriate permissions" },
  { id: "no-curl-bash-pipe", category: "safety", severity: "critical", pattern: /curl\s+\S+\s*\|\s*(?:ba)?sh/g, message: "Never pipe curl into bash; download and inspect first" },
  { id: "no-unset-vars", category: "correct", severity: "med", pattern: /\$\{\w+:?\}/g, message: "Use ${var:?} to fail on unset variables" },

  { id: "no-cd-fail", category: "correct", severity: "med", pattern: /\bcd\s+(?!.*\|\||.*&&)/g, message: "cd may fail without error handling; use cd ... || exit" },
  { id: "no-rm-rf-star", category: "safety", severity: "critical", pattern: /\brm\s+-rf?\s+\*/g, message: "rm -rf * is dangerous; be explicit about paths" },
  { id: "no-hardcoded-path", category: "maintain", severity: "low", pattern: /(?<!#)\/usr\/local\/bin\/\w+/g, message: "Hardcoded path; use command -v or environment variable" },
];

export function createShLintEngine(opts: LintEngineOptions): LintEngine {
  const engine = new LintEngine({ ...opts, extensions: SH_EXTS });
  engine.addRules(shellRules);
  return engine;
}

export { LintEngine }; export type { LintEngineOptions, LintReport };
