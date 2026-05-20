import { EslintEmitter } from "@55ndeep/tool-eslint";
import { TscEmitter } from "@55ndeep/tool-tsc";
import { SecdevEmitter } from "@55ndeep/tool-secdev";
import { RuffEmitter, PyrightEmitter, BanditEmitter } from "@55ndeep/tool-python";
import { GitnexusEmitter } from "@55ndeep/tool-gitnexus";
import { GraphifyEmitter } from "@55ndeep/tool-graphify";
import type { EventBus } from "@55ndeep/core-events";
import type { TaskLanguage } from "./task-profile.js";

function hasPython(files?: string[]): boolean {
  return (files ?? []).some((file) => file.endsWith(".py"));
}

function hasJsTs(files?: string[]): boolean {
  return (files ?? []).some((file) => /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file));
}

export function createVerificationEmitters(cwd: string, eventBus: EventBus, files?: string[], language?: TaskLanguage, writtenFiles?: string[]) {
  const pythonOnly = language === "python" || (!language && hasPython(files) && !hasJsTs(files));

  return {
    lint: pythonOnly ? new RuffEmitter({ cwd, eventBus, files }) : new EslintEmitter({ cwd, eventBus, files }),
    types: pythonOnly ? new PyrightEmitter({ cwd, eventBus, files }) : new TscEmitter({ cwd, eventBus, files }),
    security: pythonOnly ? new BanditEmitter({ cwd, eventBus, files }) : new SecdevEmitter({ cwd, eventBus }),
    changes: new GitnexusEmitter({ cwd, eventBus, writtenFiles }),
    graph: new GraphifyEmitter({ cwd, eventBus, files }),
  };
}
