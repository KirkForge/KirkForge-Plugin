import { createTSLintEngine } from "@55ndeep/tool-lint-ts";
import { createPyLintEngine } from "@55ndeep/tool-lint-py";
import { createShLintEngine } from "@55ndeep/tool-lint-sh";
import { createCLintEngine } from "@55ndeep/tool-lint-c";
import { createRsLintEngine } from "@55ndeep/tool-lint-rs";
import { createGoLintEngine } from "@55ndeep/tool-lint-go";
import { createSqlLintEngine } from "@55ndeep/tool-lint-sql";
import { TscEmitter } from "@55ndeep/tool-tsc";
import { SecdevEmitter } from "@55ndeep/tool-secdev";
import { PyrightEmitter } from "@55ndeep/tool-python";
import { GitnexusEmitter } from "@55ndeep/tool-gitnexus";
import { GraphifyEmitter } from "@55ndeep/tool-graphify";
import type { EventBus } from "@55ndeep/core-events";
import type { TaskLanguage } from "./task-profile.js";

function hasJsTs(files?: string[]): boolean {
  return (files ?? []).some((file) => /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file));
}

export function createVerificationEmitters(cwd: string, eventBus: EventBus, files?: string[], language?: TaskLanguage, writtenFiles?: string[]) {
  const pythonOnly = language === "python" || (!language && !hasJsTs(files));

  // Phase 1+2+3: 55NDeep native strict lint for all supported languages
  const tsLint = createTSLintEngine({ cwd, eventBus, files });
  const pyLint = createPyLintEngine({ cwd, eventBus, files });

  // Phase 3: Language-specific native lint
  const lintByLang: Record<string, { emit: (taskId: string) => ReturnType<typeof tsLint.emit> }> = {
    shell: createShLintEngine({ cwd, eventBus, files }),
    c: createCLintEngine({ cwd, eventBus, files }),
    cpp: createCLintEngine({ cwd, eventBus, files }),
    rust: createRsLintEngine({ cwd, eventBus, files }),
    go: createGoLintEngine({ cwd, eventBus, files }),
    sql: createSqlLintEngine({ cwd, eventBus, files }),
    text: tsLint, // fallback to TS for text
  };

  const resolvedLint = language && lintByLang[language] ? lintByLang[language]! : (pythonOnly ? pyLint : tsLint);

  return {
    lint: resolvedLint,
    types: pythonOnly ? new PyrightEmitter({ cwd, eventBus, files }) : new TscEmitter({ cwd, eventBus, files }),
    security: pythonOnly ? pyLint : new SecdevEmitter({ cwd, eventBus }),
    changes: new GitnexusEmitter({ cwd, eventBus, writtenFiles }),
    graph: new GraphifyEmitter({ cwd, eventBus, files }),
  };
}
