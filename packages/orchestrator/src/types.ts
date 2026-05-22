import type { DelegationMode, DelegationDecision } from "@55ndeep/core-types";

export interface TaskInput {
  taskId?: string;
  description: string;
  context?: string;
  files?: string[];
  modeOverride?: DelegationMode;
  taskPass?: boolean | null;
  suppressMemory?: boolean;
}

export interface DelegationResult {
  decision: DelegationDecision;
  emission: {
    agentId: string;
    content: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    model: string;
    format: "hard-prompt" | "schema-contract" | "artifact" | "task-decompose";
    schemaContract?: Record<string, unknown>;
    finishReason?: string;
    retried?: boolean;
  };
  signals: Array<{
    id: string;
    taskId: string;
    domain: string;
    kind: string;
    source: string;
    ts: string;
    value: unknown;
    confidence?: number;
  }>;
  packet?: ReducedStatePacket;
  providerResolved?: string;
  skillsLoaded?: string[];
}

export function extractWrittenFiles(result: DelegationResult): string[] {
  for (const sig of result.signals) {
    if (sig.kind === "files.written" || sig.kind === "artifact.emitted") {
      const v = sig.value as { files?: Array<string | { path: string }>; filesWritten?: number };
      if (Array.isArray(v.files)) {
        return v.files.map((f) => (typeof f === "string" ? f : f.path)).filter(Boolean);
      }
    }
  }
  return [];
}

export interface EmittedFileInfo {
  path: string;
  sha256: string;
  bytes: number;
  beforeHash: string | null;
  existed: boolean;
}

export function extractEmissionFiles(result: DelegationResult): EmittedFileInfo[] {
  for (const sig of result.signals) {
    if (sig.kind === "artifact.emitted" || sig.kind === "files.written") {
      const v = sig.value as { files?: EmittedFileInfo[]; filesWritten?: number };
      if (Array.isArray(v.files) && v.files.length > 0) {
        return v.files;
      }
    }
  }
  return [];
}

export type OrchestratorResult = import("@55ndeep/core-types").Result<DelegationResult, Error>;

import type { ReducedStatePacket } from "./reducer.js";

export interface DecompositionResult {
  rootTask: string;
  tasks: import("@55ndeep/core-types").TaskNode[];
  totalEstimatedTokens: number;
  rationale: string;
}

export interface SubtaskExecutionResult {
  nodeId: string;
  ok: boolean;
  description: string;
  language: string;
  durationMs: number;
  tokensUsed: number;
  verdict?: string;
  error?: string;
  files?: string[];
}

export interface DecompositionExecutionResult {
  rootTask: string;
  results: SubtaskExecutionResult[];
  totalSubtasks: number;
  succeededCount: number;
  failedCount: number;
  totalTokens: number;
  totalDurationMs: number;
}
