import type { DelegationMode } from "@kirkforge/core-types";
import { KirkForgeError } from "@kirkforge/core-errors";
import { ok, err } from "@kirkforge/core-types";
import { EventBus } from "@kirkforge/core-events";
import type { Logger } from "@kirkforge/core-logging";
import { scrubSecrets } from "@kirkforge/core-logging";
import type { ModelConfig, ModelProviderConfig } from "@kirkforge/model-config";
import { Agent } from "@kirkforge/agent-core";
import type { TaskBrief } from "@kirkforge/prompt-core";
import { BUILTIN_TEMPLATES, getContractTemplate } from "@kirkforge/prompt-core";
import { classifyTask } from "./classifier.js";
import { StateReducer } from "./reducer.js";
import { decideCorrection } from "./correction-loop.js";
import { createVerificationEmitters } from "./emitter-factory.js";
import { executeHardPrompt, executeSchemaContract } from "./modes.js";
import { executeArtifact } from "./artifact-mode.js";

export { parseJsonlArtifacts } from "./artifact-mode.js";
export type { JsonlArtifact, ParsedArtifact, ParseResult } from "./artifact-mode.js";
import { detectTaskProfile, profileForLanguage } from "./task-profile.js";
import type {
  TaskInput,
  DelegationResult,
  OrchestratorResult,
  OrchestratorStats,
  HealthCheckResult,
  ArtifactBlockedSignalValue,
  ArtifactUnterminatedSignalValue,
  ArtifactTruncatedSignalValue,
  ArtifactEmittedSignalValue,
} from "./types.js";
import { computeFinalVerdict } from "./truth-model.js";
import { SloMonitor, AuthPolicySloMonitor, type SloReport } from "./slo-monitor.js";
import { ClassifierMemory } from "./classifier-persistence.js";
import type { FinalVerdict, SourceOfTruth } from "./truth-model.js";
import { extractWrittenFiles, extractEmissionFiles } from "./types.js";
import type { MemoryStore } from "@kirkforge/memory-palace";
import { QuotaManager } from "@kirkforge/core-enterprise";
import type { Recommendation } from "@kirkforge/memory-palace";
import type {
  ReducedStatePacket,
  CorrectionDecision,
  TaskValidationResult,
  TaskOutcome,
} from "@kirkforge/correction-core";
import { taskOutcomeFromValidation, makeSkippedValidation } from "@kirkforge/correction-core";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute, dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { shouldExcludeFromTurnCopy, outputSummary } from "./workspace.js";
import { estimateSimpleCost, resolveCostProviderKey } from "./cost.js";

export { StateReducer } from "./reducer.js";
export type { ReducedStatePacket } from "./reducer.js";
export { createVerificationEmitters } from "./emitter-factory.js";
export { decideCorrection } from "./correction-loop.js";
export { buildCorrectionPrompt, toolNames } from "@kirkforge/correction-core";
export type { CorrectionConfig, CorrectionDecision } from "@kirkforge/correction-core";
export type { TaskInput, DelegationResult, OrchestratorResult } from "./types.js";
export type { OrchestratorStats, HealthCheckResult } from "./types.js";
export type {
  DecompositionResult,
  SubtaskExecutionResult,
  DecompositionExecutionResult,
} from "./types.js";
export type { FinalVerdict, SourceOfTruth } from "./truth-model.js";
export { extractWrittenFiles } from "./types.js";
export type { TaskLanguage, TaskProfile, EmissionSchema } from "./task-profile.js";
export { detectTaskProfile, extensionForLanguage, profileForLanguage } from "./task-profile.js";
export { resolveValidatorShellCommand };

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// shouldExcludeFromTurnCopy extracted to workspace.ts

export interface ValidatorRunConfig {
  shellCommand?: string;
  timeoutMs?: number;
}

export interface LegacyValidatorRunConfig {
  command?: string;
  timeoutMs?: number;
}

export interface StructuredValidatorConfig {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

function resolveValidatorShellCommand(
  validator?: ValidatorRunConfig | LegacyValidatorRunConfig | StructuredValidatorConfig,
): string | undefined {
  if (!validator) return undefined;
  if ("shellCommand" in validator && validator.shellCommand) return validator.shellCommand;
  if (
    "command" in validator &&
    !(validator as StructuredValidatorConfig).args &&
    (validator as LegacyValidatorRunConfig).command
  )
    return (validator as LegacyValidatorRunConfig).command;
  return undefined;
}

function resolveStructuredValidatorConfig(
  validator?: ValidatorRunConfig | LegacyValidatorRunConfig | StructuredValidatorConfig,
): StructuredValidatorConfig | undefined {
  if (!validator) return undefined;
  if (
    "command" in validator &&
    "args" in validator &&
    Array.isArray((validator as StructuredValidatorConfig).args)
  )
    return validator as StructuredValidatorConfig;
  return undefined;
}

export interface CorrectionLoopConfig {
  maxCorrections: number;
  maxCost?: number;
  maxValidatorMs?: number;
  validator?: ValidatorRunConfig | LegacyValidatorRunConfig | StructuredValidatorConfig;
}

export interface CorrectionLoopOutcome {
  finalAction: "accept" | "escalate";
  finalVerdict: FinalVerdict;
  sourceOfTruth: SourceOfTruth;
  taskValidation: TaskValidationResult;
  taskOutcome: TaskOutcome;
  turns: CorrectionDecision[];
  allPackets: ReducedStatePacket[];
  sessionTokens: number;
  sessionCost: number;
  validatorDurationMs: number;
}

export interface OrchestratorConfig {
  modelConfig: ModelConfig;
  providerKey?: string;
  logger?: Logger;
  eventBus?: EventBus;
  memoryStore?: MemoryStore;
  cwd?: string;
  decomposeProvider?: string;
  /** Policy engine for deny-by-default enforcement. If set, tools and models are checked before execution. */
  policyEngine?: import("@kirkforge/core-policy").PolicyEngine;
  /** Audit logger for policy deny events. */
  auditLogger?: import("@kirkforge/core-events").AuditLogger;
  /** Per-tenant quota manager. If set, quotas are checked before execution. */
  quotaManager?: QuotaManager;
}

export class Orchestrator {
  private modelConfig: ModelConfig;
  private providerKey: string;
  private logger?: Logger;
  private reducer: StateReducer;
  private sharedEventBus: EventBus;
  private memoryStore?: MemoryStore;
  private cwd: string;
  private decomposeProvider: string;
  private maxRetries: number;
  private retryBaseDelayMs: number;
  private stats: OrchestratorStats = { totalDelegations: 0, totalTokens: 0 };
  private _shuttingDown = false;
  private _classifierLoaded = false;
  private _busy = false;
  private _sloMonitor: SloMonitor | null = null;
  private _authPolicySlo: AuthPolicySloMonitor;
  private _classifierMemory: ClassifierMemory | null = null;
  private _baselineSnapshotDir: string | null = null;
  private _isolatedBaselineDirs: string[] = [];
  private _policyEngine?: import("@kirkforge/core-policy").PolicyEngine;
  private _auditLogger?: import("@kirkforge/core-events").AuditLogger;
  private _quotaManager?: QuotaManager;

  constructor(config: OrchestratorConfig) {
    this.modelConfig = config.modelConfig;
    this.providerKey = config.providerKey ?? config.modelConfig.defaultProvider;
    this.cwd = config.cwd ?? process.cwd();
    this.decomposeProvider = config.decomposeProvider ?? config.modelConfig.defaultProvider;
    this.logger = config.logger;
    this.memoryStore = config.memoryStore;
    this.maxRetries = 3;
    this.retryBaseDelayMs = 1000;
    const eb = config.eventBus ?? new EventBus();
    this.sharedEventBus = eb;
    this.reducer = new StateReducer(eb);
    if (this.memoryStore) {
      this._sloMonitor = new SloMonitor(this.memoryStore);
    }
    this._classifierMemory = new ClassifierMemory(this.memoryStore);
    this._authPolicySlo = new AuthPolicySloMonitor();
    this._policyEngine = config.policyEngine;
    this._auditLogger = config.auditLogger;
    this._quotaManager = config.quotaManager;
  }

  async delegate(task: TaskInput): Promise<OrchestratorResult> {
    if (this._shuttingDown) return err(new Error("Orchestrator is shutting down"));
    const taskId = task.taskId ?? `task-${Date.now()}`;

    // ── Policy enforcement ──────────────────────────────────────────
    // If a policy engine is configured, check tools and models before
    // proceeding. Deny-by-default: if the policy blocks the action,
    // return an error and audit-log the denial.
    if (this._policyEngine) {
      const providerConfig = this._resolveProvider(null);
      const modelDecision = this._policyEngine.checkModel(providerConfig.defaultModel);
      if (!modelDecision.allowed) {
        this._auditPolicyDeny(
          "model.deny",
          modelDecision.reason,
          modelDecision.policyHash,
          task.actor,
        );
        return err(
          new KirkForgeError("POLICY_DENIED", modelDecision.reason, {
            rule: modelDecision.rule,
            policyHash: modelDecision.policyHash,
          }),
        );
      }
      const profile = detectTaskProfile(task.description);
      const toolDecision = this._policyEngine.checkTool(profile.language ?? "unknown");
      if (!toolDecision.allowed) {
        this._auditPolicyDeny(
          "tool.deny",
          toolDecision.reason,
          toolDecision.policyHash,
          task.actor,
        );
        return err(
          new KirkForgeError("POLICY_DENIED", toolDecision.reason, {
            rule: toolDecision.rule,
            policyHash: toolDecision.policyHash,
          }),
        );
      }
    }

    let decision = classifyTask(task, this._classifierMemory);
    const profile = detectTaskProfile(task.description);
    const memoryRecommendation = await this._recallMemory(task);
    if (
      !task.modeOverride &&
      memoryRecommendation?.routingBias &&
      memoryRecommendation.confidence >= 0.75 &&
      memoryRecommendation.evidence >= 3
    ) {
      decision = {
        ...decision,
        mode: memoryRecommendation.mode as typeof decision.mode,
        reason: `${decision.reason}; memory bias ${memoryRecommendation.mode} (${memoryRecommendation.evidence} similar)`,
      };
    }
    this.logger?.info(
      `[orchestrator] Routing "${task.description.slice(0, 80)}" → ${decision.mode} (${decision.reason})`,
    );

    const providerConfig = this._resolveProvider(memoryRecommendation);
    const delegationStartedAt = Date.now();

    switch (decision.mode) {
      case "hard-prompt": {
        const agent = new Agent(
          `agent-${taskId}`,
          providerConfig,
          BUILTIN_TEMPLATES["hard-prompt"],
        );
        const brief = this._makeBrief(task);
        return this._finalizeDelegation(
          await executeHardPrompt(agent, brief, taskId, this.cwd, profile),
          taskId,
          task,
          decision.mode,
          profile,
          providerConfig,
          delegationStartedAt,
        );
      }
      case "schema-contract": {
        const contractTemplate = getContractTemplate(profile.language, profile.promptHint);
        const agent = new Agent(`agent-${taskId}`, providerConfig, contractTemplate);
        const brief = this._makeBrief(task);
        return this._finalizeDelegation(
          await executeSchemaContract(agent, brief, taskId),
          taskId,
          task,
          decision.mode,
          profile,
          providerConfig,
          delegationStartedAt,
        );
      }
      case "task-decompose": {
        const decomp = await this.decomposeTask(task);
        if (!decomp.ok) return err(decomp.error);
        const dr: DelegationResult = {
          decision,
          emission: {
            agentId: "decomposer",
            content: JSON.stringify(decomp.value.tasks),
            promptTokens: decomp.value.totalEstimatedTokens,
            completionTokens: 0,
            totalTokens: decomp.value.totalEstimatedTokens,
            model: "decompose",
            format: "task-decompose",
            schemaContract: {
              taskCount: decomp.value.tasks.length,
              rationale: decomp.value.rationale,
              tasks: decomp.value.tasks,
            },
          },
          signals: [
            {
              id: `sig-${taskId}`,
              taskId,
              domain: "task",
              kind: "decomposed",
              source: "decomposer",
              ts: new Date().toISOString(),
              value: {
                taskCount: decomp.value.tasks.length,
                tasks: decomp.value.tasks.map((t) => t.id),
              },
            },
          ],
        };
        return this._finalizeDelegation(
          ok(dr),
          taskId,
          task,
          decision.mode,
          profile,
          providerConfig,
          delegationStartedAt,
        );
      }

      case "artifact": {
        const agent = new Agent(`agent-${taskId}`, providerConfig, BUILTIN_TEMPLATES["artifact"]);
        const brief = this._makeBrief(task);
        return this._finalizeDelegation(
          await executeArtifact(agent, brief, taskId, this.cwd, profile),
          taskId,
          task,
          decision.mode,
          profile,
          providerConfig,
          delegationStartedAt,
        );
      }
    }
  }

  async runCorrectionLoop(
    task: TaskInput,
    config: CorrectionLoopConfig,
  ): Promise<CorrectionLoopOutcome> {
    if (this._busy)
      throw new Error("Orchestrator busy — only one correction loop may run concurrently");
    this._busy = true;
    const baseId = task.taskId ?? `task-${Date.now()}`;
    let taskId = baseId;
    const originalDescription = task.description;
    const originalProfile = detectTaskProfile(originalDescription);
    const profile = originalProfile;
    const turns: CorrectionDecision[] = [];
    const allPackets: ReducedStatePacket[] = [];
    let sessionTokens = 0;
    let sessionCost = 0;
    let done = false;
    let taskValidation: TaskValidationResult = makeSkippedValidation(
      "none",
      "no task validator configured",
    );
    const loopStartedAt = Date.now();
    try {
      if (this._classifierMemory && !this._classifierLoaded) {
        await this._classifierMemory.loadFromStore();
        this._classifierLoaded = true;
      }
      let actualMode: string = classifyTask(task, this._classifierMemory).mode;
      let actualModel: string = "unknown";
      const validatorShellCommand = resolveValidatorShellCommand(config.validator);
      const structuredValidator = resolveStructuredValidatorConfig(config.validator);

      // Snapshot the workspace once as a clean baseline so consecutive
      // turn copies and validator workspaces are based on a single frozen
      // state.  Concurrent edits during the correction loop cannot
      // contaminate verification.
      const _originalCwd = this.cwd; // preserved for debug
      const baselineCwd = this._ensureBaselineSnapshot();
      for (let turn = 0; turn <= config.maxCorrections && !done; turn++) {
        const result = await this._runIsolatedTurn(task, taskId, baselineCwd);
        if (!result.ok) {
          turns.push({
            action: "escalate",
            rationale: `delegation failed: ${result.error.message}`,
            packet: this.reducer.reduce(
              taskId,
              turn,
              profile.verifierPolicy,
              this._policyEngine?.getHash(),
            ),
            correctionCount: turn,
            workerTokens: 0,
            sessionTokens,
          });
          allPackets.push(
            this.reducer.reduce(
              taskId,
              turn,
              profile.verifierPolicy,
              this._policyEngine?.getHash(),
            ),
          );
          this._cleanupTurnWorkspace();
          break;
        }

        const delegationResult = result.value;
        actualMode = delegationResult.emission.format;
        actualModel = delegationResult.emission.model;

        const emission = delegationResult.emission;
        const workerTokens = emission.totalTokens;
        sessionTokens += workerTokens;
        const costKey = resolveCostProviderKey(delegationResult.providerResolved ?? "local-ollama");
        sessionCost += estimateSimpleCost(
          costKey,
          emission.promptTokens,
          emission.completionTokens,
        );

        const packet =
          delegationResult.packet ??
          this.reducer.reduce(taskId, turn, profile.verifierPolicy, this._policyEngine?.getHash());
        const emittedFiles = packet.emissions?.files?.map((f) => ({ path: f.path })) ?? [];
        if (structuredValidator) {
          taskValidation = await this._runStructuredTaskValidator(
            structuredValidator,
            emittedFiles,
            this._activeTurnWorkspace ?? undefined,
          );
          task = {
            ...task,
            taskPass:
              taskValidation.status === "pass"
                ? true
                : taskValidation.status === "fail"
                  ? false
                  : null,
          };
        } else if (validatorShellCommand) {
          taskValidation = await this._runTaskValidator(
            validatorShellCommand,
            config.validator?.timeoutMs ?? 120000,
            emittedFiles,
            this._activeTurnWorkspace ?? undefined,
          );
          task = {
            ...task,
            taskPass:
              taskValidation.status === "pass"
                ? true
                : taskValidation.status === "fail"
                  ? false
                  : null,
          };
        }
        this._cleanupTurnWorkspace();

        // If validator had an infrastructure error (timeout, crash, missing tool),
        // escalate immediately rather than consuming correction attempts
        if (taskValidation.status === "error") {
          const escalateDecision: CorrectionDecision = {
            action: "escalate",
            rationale: `validator infrastructure error: ${taskValidation.reason ?? "unknown"}`,
            packet,
            correctionCount: turn,
            workerTokens,
            sessionTokens,
          };
          turns.push(escalateDecision);
          allPackets.push(packet);
          done = true;
          this._cleanupTurnWorkspace();
          continue;
        }

        const decision = decideCorrection(
          packet,
          turn,
          config.maxCorrections,
          workerTokens,
          sessionTokens,
          sessionCost,
          config.maxCost,
          profile.language,
          task.taskPass,
        );

        turns.push(decision);
        allPackets.push(packet);

        if (decision.action === "correct") {
          const nextTaskId = `${baseId}-c${turn + 1}`;
          const validatorFeedback =
            taskValidation.status === "fail"
              ? `\n\nExternal task validator (${taskValidation.validator}) ${taskValidation.status}: ${taskValidation.reason ?? "no reason provided"}`
              : "";
          // Validator infrastructure errors (timeout, crash, missing tool) are NOT sent as correction
          // feedback — the model cannot fix host/infrastructure problems.
          // taskPass === null means validator error/skip, which should escalate not correct.
          task = {
            ...task,
            description:
              task.description + "\n\n" + (decision.correctionPrompt ?? "") + validatorFeedback,
            taskId: nextTaskId,
          };
          taskId = nextTaskId;
        } else {
          done = true;
        }
      }
      this._cleanupTurnWorkspace();

      let finalAction: "accept" | "escalate" =
        turns[turns.length - 1]!.action === "accept" ? "accept" : "escalate";
      if ((validatorShellCommand || structuredValidator) && taskValidation.status !== "pass") {
        finalAction = "escalate";
      }
      const loopDurationMs = Date.now() - loopStartedAt;
      const taskOutcome = taskOutcomeFromValidation(taskValidation);
      const lastPacket = allPackets[allPackets.length - 1];
      const protocolBroken =
        lastPacket?.artifactEnforcement?.status === "fail" &&
        (lastPacket.artifactEnforcement.unterminated || lastPacket.artifactEnforcement.truncated);
      const truth = computeFinalVerdict({
        taskValidation,
        hasValidator: !!(validatorShellCommand || structuredValidator),
        finalAction,
        packet: lastPacket,
        profile: { language: profile.language, validatorRequired: profile.validatorRequired },
        actualMode,
        protocolBroken,
      });
      const sourceOfTruth = truth.sourceOfTruth;
      const finalVerdict = truth.finalVerdict;
      await this._writeCorrectionMemoryObservation(
        originalDescription,
        originalProfile.language,
        task,
        taskId,
        finalAction,
        turns,
        allPackets,
        sessionTokens,
        taskValidation,
        finalVerdict,
        sourceOfTruth,
        actualModel,
        actualMode,
        loopDurationMs,
      );

      // Learn from outcome to improve future NLP classification
      if (this._classifierMemory) {
        const outcomeClass =
          taskOutcome === "pass"
            ? "pass"
            : taskValidation.status === "error"
              ? "validator_error"
              : "task_fail";
        this._classifierMemory.learn(
          originalDescription,
          actualMode as DelegationMode,
          outcomeClass,
        );
      }
      await this._flushMemory();
      return {
        finalAction,
        finalVerdict,
        sourceOfTruth,
        taskValidation,
        taskOutcome,
        turns,
        allPackets,
        sessionTokens,
        sessionCost,
        validatorDurationMs: taskValidation.durationMs ?? 0,
      };
    } catch (error) {
      this._busy = false;
      const errMsg = error instanceof Error ? error.message : String(error);
      this.logger?.error(`[orchestrator] runCorrectionLoop crashed: ${errMsg}`);
      const escalateDecision: CorrectionDecision = {
        action: "escalate",
        rationale: `internal orchestrator error: ${errMsg}`,
        packet: this.reducer.reduce(
          taskId,
          0,
          profile.verifierPolicy,
          this._policyEngine?.getHash(),
        ),
        correctionCount: turns.length,
        workerTokens: 0,
        sessionTokens,
      };
      turns.push(escalateDecision);
      allPackets.push(
        this.reducer.reduce(taskId, 0, profile.verifierPolicy, this._policyEngine?.getHash()),
      );
      const taskValidation: TaskValidationResult = {
        status: "error",
        validator: "orchestrator",
        reason: errMsg,
      };
      try {
        if (this._classifierMemory) {
          this._classifierMemory.learn(
            originalDescription,
            "hard-prompt" as DelegationMode,
            "validator_error",
          );
        }
      } catch {
        /* best effort */
      }
      try {
        await this._flushMemory();
      } catch {
        /* best effort */
      }
      return {
        finalAction: "escalate",
        finalVerdict: "unknown",
        sourceOfTruth: "verifier",
        taskValidation,
        taskOutcome: "error" as TaskOutcome,
        turns,
        allPackets,
        sessionTokens,
        sessionCost: sessionCost ?? 0,
        validatorDurationMs: 0,
      };
    } finally {
      this._busy = false;
      this._cleanupIsolatedWorkspace();
      this._cleanupTurnWorkspace();
    }
  }

  reduce(taskId: string, turn?: number): ReducedStatePacket {
    return this.reducer.reduce(taskId, turn ?? 0);
  }

  async verify(
    task: { taskId?: string; description?: string; files?: string[] } = {},
  ): Promise<ReducedStatePacket> {
    const taskId = task.taskId ?? `verify-${Date.now()}`;
    const profile = detectTaskProfile(task.description ?? "verify current TypeScript workspace");
    await this._runVerifiers(taskId, task.files, profile.language);
    const packet = this.reducer.reduce(
      taskId,
      0,
      profile.verifierPolicy,
      this._policyEngine?.getHash(),
    );
    this.reducer.resetTask(taskId);
    return packet;
  }

  getStats(): OrchestratorStats {
    return { ...this.stats };
  }

  getReducer(): StateReducer {
    return this.reducer;
  }
  getEventBus(): EventBus {
    return this.sharedEventBus;
  }

  private _auditPolicyDeny(
    action: "model.deny" | "tool.deny",
    reason: string,
    policyHash: string,
    actor?: import("@kirkforge/core-rbac").Actor,
  ): void {
    // Track policy deny for SLO monitoring
    this._authPolicySlo.record({
      timestamp: Date.now(),
      type: "policy.deny",
      actorId: actor?.id,
      tenantId: actor?.tenantId,
    });
    if (!this._auditLogger) return;
    this._auditLogger
      .record({
        action: action as "model.deny" | "tool.deny",
        outcome: "deny",
        actorId: actor?.id ?? "system",
        tenantId: actor?.tenantId ?? "",
        reason,
        policyHash,
      })
      .then((ok) => {
        this._authPolicySlo.record({
          timestamp: Date.now(),
          type: ok ? "audit.write.success" : "audit.write.failure",
        });
      })
      .catch(() => {
        this._authPolicySlo.record({
          timestamp: Date.now(),
          type: "audit.write.failure",
        });
      });
  }

  private _resolveProvider(memoryRecommendation?: Recommendation | null): ModelProviderConfig {
    const pc = this.modelConfig.providers[this.providerKey];
    if (pc) return this._applyMemoryModelBias(pc, memoryRecommendation);
    const dp = this.modelConfig.providers[this.modelConfig.defaultProvider];
    if (dp) return this._applyMemoryModelBias(dp, memoryRecommendation);
    throw new Error(`No provider found`);
  }

  private _applyMemoryModelBias(
    providerConfig: ModelProviderConfig,
    memoryRecommendation?: Recommendation | null,
  ): ModelProviderConfig {
    const preferred = memoryRecommendation?.routingBias?.prefer?.[0];
    const confidence = memoryRecommendation?.routingBias?.confidence ?? 0;
    if (!preferred || confidence < 0.65 || preferred === providerConfig.defaultModel)
      return providerConfig;
    const isProviderModel = preferred.includes(":")
      ? preferred.startsWith(providerConfig.provider + ":")
      : true;
    if (!isProviderModel) {
      this.logger?.info(
        `[orchestrator] Memory bias prefers ${preferred} but it belongs to a different provider than ${providerConfig.provider}; ignoring cross-provider bias`,
      );
      return providerConfig;
    }
    const isKnownModel =
      preferred.includes(":") ||
      preferred === providerConfig.defaultModel ||
      Object.values(this.modelConfig.providers).some((p) => p.defaultModel === preferred);
    if (!isKnownModel) {
      this.logger?.info(
        `[orchestrator] Memory bias prefers ${preferred} which is not a known model for provider ${providerConfig.provider}; ignoring unknown model bias`,
      );
      return providerConfig;
    }
    this.logger?.info(
      `[orchestrator] Memory bias prefers model ${preferred} over ${providerConfig.defaultModel} (${Math.round(confidence * 100)}% confidence)`,
    );
    return { ...providerConfig, defaultModel: preferred };
  }

  private async _recallMemory(task: TaskInput): Promise<Recommendation | null> {
    if (!this.memoryStore) return null;
    try {
      const result = await this.memoryStore.recall(task.description);
      return result.ok ? result.value : null;
    } catch (e) {
      this.logger?.warn(
        `[orchestrator] Memory recall failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  private async _runVerifiers(
    taskId: string,
    files?: string[],
    language?: ReturnType<typeof detectTaskProfile>["language"],
    writtenFiles?: string[],
  ): Promise<void> {
    const profile = language ? profileForLanguage(language) : undefined;
    if (profile?.checkCommand && writtenFiles && writtenFiles.length > 0) {
      await this._runCheckCommand(
        profile.checkCommand,
        writtenFiles,
        taskId,
        profile.structuredCheck,
      );
    }
    const eb = this.sharedEventBus;
    const emitters = createVerificationEmitters(this.cwd, eb, files, language, writtenFiles);
    await Promise.allSettled([
      emitters.lint.emit(taskId),
      emitters.types.emit(taskId),
      emitters.security.emit(taskId),
      emitters.changes.emit(taskId),
      emitters.graph.emit(taskId),
    ]);
  }

  private async _runCheckCommand(
    checkCommand: string,
    files: string[],
    taskId: string,
    structured?: { command: string; args: string[]; appendFiles?: boolean },
  ): Promise<void> {
    if (structured && structured.command) {
      const args =
        structured.appendFiles !== false ? [...structured.args, ...files] : structured.args;
      try {
        const { stdout, stderr } = await execFileAsync(structured.command, args, {
          cwd: this.cwd,
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
        const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
        if (output) {
          this.logger?.info(
            `[orchestrator] checkCommand ${structured.command} passed for ${files.length} file(s)`,
          );
        }
      } catch (e) {
        const errObj = e as { stdout?: string; stderr?: string; message?: string };
        const output = `${errObj.stdout ?? ""}${errObj.stderr ? `\n${errObj.stderr}` : ""}`.trim();
        this.logger?.warn(
          `[orchestrator] checkCommand ${structured.command} failed: ${output || errObj.message || "unknown error"}`,
        );
        await this.sharedEventBus.emit({
          kind: "verify.types",
          schemaVersion: "v3",
          sequence: 1,
          streamId: taskId,
          taskId,
          value: {
            status: "fail",
            errors: 1,
            durationMs: 0,
            details: [
              {
                file: "<checkCommand>",
                line: 0,
                code: "CHECK_CMD_FAIL",
                message: `${structured.command}: ${output || errObj.message || "failed"}`,
              },
            ],
          },
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }
    if (!checkCommand) return;
    const parts = checkCommand.split(/\s+/);
    const cmd = parts[0];
    if (!cmd || files.length === 0) return;
    const args = [...parts.slice(1), ...files];
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, {
        cwd: this.cwd,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      if (output) {
        this.logger?.info(
          `[orchestrator] checkCommand ${checkCommand} passed for ${files.length} file(s)`,
        );
      }
    } catch (e) {
      const errObj = e as { stdout?: string; stderr?: string; message?: string };
      const output = `${errObj.stdout ?? ""}${errObj.stderr ? `\n${errObj.stderr}` : ""}`.trim();
      this.logger?.warn(
        `[orchestrator] checkCommand ${checkCommand} failed: ${output || errObj.message || "unknown error"}`,
      );
      await this.sharedEventBus.emit({
        kind: "verify.types",
        schemaVersion: "v3",
        sequence: 1,
        streamId: taskId,
        taskId,
        value: {
          status: "fail",
          errors: 1,
          durationMs: 0,
          details: [
            {
              file: "<checkCommand>",
              line: 0,
              code: "CHECK_CMD_FAIL",
              message: `${checkCommand}: ${output || errObj.message || "failed"}`,
            },
          ],
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  private _makeBrief(task: TaskInput): TaskBrief {
    const profile = detectTaskProfile(task.description);
    const forbiddenList =
      profile.forbiddenExtensions.length > 0
        ? `\nForbidden file types: ${profile.forbiddenExtensions.join(", ")}.`
        : "";
    const emissionRules =
      profile.allowedExtensions.length > 0
        ? `\nAllowed file extensions for ${profile.language}: ${profile.allowedExtensions.join(", ")}.`
        : "";
    const contextSection = task.context ? `\nContext: ${task.context}` : "";
    const filesSection =
      task.files && task.files.length > 0 ? `\nTarget files: ${task.files.join(", ")}` : "";
    return {
      description: task.description + contextSection + filesSection,
      variables: {
        files: task.files?.join(", ") ?? "",
        language: profile.language,
        defaultFile: profile.defaultFile,
        languageHint: profile.promptHint,
        checkCommand: profile.checkCommand,
        emissionRules,
        forbiddenRules: forbiddenList,
        context: task.context ?? "",
      },
    };
  }

  private async _writeMemoryObservation(
    task: TaskInput,
    taskId: string,
    mode: string,
    result: DelegationResult,
    language: string,
    durationMs: number,
    emissions?: Array<{
      path: string;
      sha256: string;
      bytes: number;
      beforeHash: string | null;
      existed: boolean;
    }>,
  ): Promise<void> {
    if (!this.memoryStore) return;
    const packet = result.packet;
    let outcome: "pass" | "fail" | "error";
    let reason: string;
    if (task.taskPass === true) {
      outcome = "pass";
      reason = "task passed";
    } else if (task.taskPass === false) {
      outcome = "fail";
      reason = "task tests failed";
    } else {
      outcome = "error";
      reason = "task outcome unknown";
    }
    try {
      await this.memoryStore.writeTaskObservation({
        taskId,
        description: task.description,
        language,
        mode,
        model: result.emission.model,
        promptShape: result.emission.format,
        verifierOverall: packet?.verification.overall,
        finalAction:
          task.taskPass === true
            ? "accept"
            : packet?.verification.overall === "pass"
              ? "accept"
              : "escalate",
        taskPass: task.taskPass,
        outcome,
        reason,
        tokens: result.emission.totalTokens,
        durationMs,
        turns: 1,
        emissions: emissions ?? [],
      });
    } catch (e) {
      this.logger?.warn(
        `[orchestrator] Memory write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private async _writeCorrectionMemoryObservation(
    originalDescription: string,
    originalLanguage: string,
    task: TaskInput,
    taskId: string,
    finalAction: "accept" | "escalate",
    turns: CorrectionDecision[],
    packets: ReducedStatePacket[],
    sessionTokens: number,
    taskValidation: TaskValidationResult,
    finalVerdict: FinalVerdict,
    sourceOfTruth: SourceOfTruth,
    actualModel: string,
    actualMode: string,
    durationMs: number,
  ): Promise<void> {
    if (!this.memoryStore || packets.length === 0) return;

    // Scrub secrets from validator stdout/stderr before persisting
    const scrubbedValidation = structuredClone(taskValidation);
    if (scrubbedValidation.details && typeof scrubbedValidation.details === "object") {
      const d = scrubbedValidation.details as Record<string, unknown>;
      if (typeof d.stdout === "string") d.stdout = scrubSecrets(d.stdout);
      if (typeof d.stderr === "string") d.stderr = scrubSecrets(d.stderr);
    }

    const lastPacket = packets[packets.length - 1]!;

    let outcome: "pass" | "fail" | "error";
    if (task.taskPass === true) {
      outcome = "pass";
    } else if (task.taskPass === false) {
      outcome = "fail";
    } else if (taskValidation.status === "pass") {
      outcome = "pass";
    } else if (taskValidation.status === "fail") {
      outcome = "fail";
    } else {
      outcome = "error";
    }

    let outcomeClass:
      | "pass"
      | "task_fail"
      | "validator_error"
      | "tool_error"
      | "escalated"
      | "unknown";
    if (outcome === "pass") {
      outcomeClass = "pass";
    } else if (task.taskPass === false) {
      outcomeClass = "task_fail";
    } else if (taskValidation.status === "error") {
      outcomeClass = "validator_error";
    } else if (finalAction === "escalate") {
      outcomeClass = "escalated";
    } else if (finalVerdict === "unknown") {
      outcomeClass = "unknown";
    } else {
      outcomeClass = "tool_error";
    }

    let routingLesson: "reward" | "punish" | "neutral";
    if (outcomeClass === "pass") {
      routingLesson = "reward";
    } else if (outcomeClass === "task_fail") {
      routingLesson = "punish";
    } else {
      routingLesson = "neutral";
    }

    const reason =
      task.taskPass === false
        ? taskValidation.status === "fail" || taskValidation.status === "error"
          ? `task validator ${taskValidation.status}: ${taskValidation.reason ?? "validator failed"}`
          : "task validator failed"
        : task.taskPass === true
          ? "task passed"
          : finalAction === "accept"
            ? "verification passed"
            : finalAction === "escalate"
              ? "correction loop escalated"
              : "task outcome unknown";

    const providerKey = this.providerKey;
    const providerConfig = this.modelConfig.providers[providerKey];
    const providerType = providerConfig?.provider ?? "unknown";
    const baseUrl = providerConfig?.baseUrl;

    const emissions = lastPacket.emissions?.files ?? [];
    const filesEmitted = emissions.length;
    const totalBytesEmitted = emissions.reduce((s, f) => s + f.bytes, 0);

    try {
      await this.memoryStore.writeTaskObservation({
        taskId,
        description: originalDescription,
        language: originalLanguage,
        mode: actualMode,
        model: actualModel,
        providerKey,
        providerType,
        baseUrl,
        promptShape: "correction-loop",
        verifierOverall: lastPacket.verification.overall,
        finalAction,
        taskPass: task.taskPass,
        outcome,
        outcomeClass,
        routingLesson,
        reason,
        finalVerdict,
        sourceOfTruth,
        taskValidation: scrubbedValidation,
        tokens: sessionTokens,
        durationMs,
        turns: turns.length,
        validatorDurationMs: taskValidation.durationMs ?? 0,
        emissions: emissions.map((f) => ({
          path: f.path,
          sha256: f.sha256,
          bytes: f.bytes,
          beforeHash: f.beforeHash ?? null,
          existed: f.existed ?? false,
        })),
      });

      const runId = `run-${taskId}-${Date.now()}-${randomBytes(4).toString("hex")}`;
      const runTurn = turns.length;

      // Pre-compute emission IDs so they can be stored on the run record
      const emissionRecords = emissions.map((f, _i) => ({
        path: f.path,
        sha256: f.sha256,
        bytes: f.bytes,
        beforeHash: f.beforeHash ?? null,
        existed: f.existed ?? false,
      }));
      const preEmissionIds = emissionRecords.map((e, i) => {
        const pathHash = createHash("sha256").update(e.path).digest("hex").slice(0, 8);
        const sha256Prefix = e.sha256.slice(0, 8);
        return `emission-${runId}-t${runTurn}-${i}-${pathHash}-${sha256Prefix}`;
      });

      // Write run record FIRST with emission IDs populated
      const runRecord = {
        runId,
        taskId,
        description: originalDescription,
        language: originalLanguage,
        mode: actualMode,
        model: actualModel,
        providerKey,
        providerType,
        baseUrl,
        outcome,
        outcomeClass,
        routingLesson,
        finalVerdict,
        sourceOfTruth,
        finalAction,
        tokens: sessionTokens,
        durationMs,
        turns: runTurn,
        validatorDurationMs: taskValidation.durationMs ?? 0,
        verifierOverall: lastPacket.verification.overall,
        filesEmitted,
        totalBytesEmitted,
        emissions,
        emissionIds: preEmissionIds,
        timestamp: new Date().toISOString(),
      };
      // Write run and emissions transactionally
      await this.memoryStore.writeRunAndEmissions(runRecord, emissionRecords, runTurn);
    } catch (e) {
      this.logger?.warn(
        `[orchestrator] Memory write (correction) failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  private _isolatedWorkspaceDirs: string[] = [];
  private _activeTurnWorkspace: string | null = null;

  private async _runIsolatedTurn(
    task: TaskInput,
    taskId: string,
    originalCwd: string,
  ): Promise<OrchestratorResult> {
    const turnWorkspace = mkdtempSync(join(tmpdir(), "kirkforge-turn-"));
    try {
      cpSync(originalCwd, turnWorkspace, {
        recursive: true,
        dereference: false,
        filter: (src: string) => shouldExcludeFromTurnCopy(src, originalCwd.length),
      });
      const savedCwd = this.cwd;
      this.cwd = turnWorkspace;
      try {
        return await this.delegate({ ...task, taskId, suppressMemory: true });
      } finally {
        this.cwd = savedCwd;
      }
    } finally {
      // Keep workspace alive for task validators that run after delegation
      this._activeTurnWorkspace = turnWorkspace;
    }
  }

  private _cleanupTurnWorkspace(): void {
    try {
      if (this._activeTurnWorkspace) {
        rmSync(this._activeTurnWorkspace, { recursive: true, force: true });
        this._activeTurnWorkspace = null;
      }
    } catch {
      /* best effort */
    }
  }

  private async _createIsolatedWorkspace(
    emittedFiles?: Array<{ path: string; content?: string }>,
    baselineDir?: string,
  ): Promise<string> {
    try {
      const tmpDir = mkdtempSync(join(tmpdir(), "kirkforge-validator-"));

      if (emittedFiles && emittedFiles.length > 0) {
        // Copy baseline workspace first so validators (e.g. tsc, linters) have
        // full project context. Then overlay emitted files from this run on top.
        const baseline = baselineDir ?? this.cwd;
        cpSync(baseline, tmpDir, {
          recursive: true,
          dereference: false,
          filter: (src: string) => shouldExcludeFromTurnCopy(src, baseline.length),
        });

        // Overlay emissions on top of baseline
        for (const f of emittedFiles) {
          const src = resolve(baselineDir ?? this.cwd, f.path);
          const dst = resolve(tmpDir, f.path);
          try {
            mkdirSync(dirname(dst), { recursive: true });
            if (f.content !== undefined) {
              writeFileSync(dst, f.content, "utf-8");
            } else {
              try {
                copyFileSync(src, dst);
              } catch {
                /* file may not exist — skip */
              }
            }
          } catch {
            /* best effort per file */
          }
        }
      } else {
        // Legacy fallback: copy full cwd (used when emitted files unknown)
        const baseline = baselineDir ?? this.cwd;
        cpSync(baseline, tmpDir, {
          recursive: true,
          dereference: false,
          filter: (src: string) => shouldExcludeFromTurnCopy(src, baseline.length),
        });
      }

      this._isolatedWorkspaceDirs.push(tmpDir);
      return tmpDir;
    } catch (e) {
      this.logger?.error(
        `[orchestrator] Failed to create isolated validator workspace: ${e instanceof Error ? e.message : String(e)}`,
      );
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  private _cleanupIsolatedWorkspace(): void {
    for (const dir of this._isolatedWorkspaceDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this._isolatedWorkspaceDirs = [];
  }

  private _cleanupBaselineDirs(): void {
    for (const dir of this._isolatedBaselineDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    this._isolatedBaselineDirs = [];
  }

  private _ensureBaselineSnapshot(): string {
    if (this._baselineSnapshotDir) return this._baselineSnapshotDir;
    const snapshotDir = mkdtempSync(join(tmpdir(), "kirkforge-baseline-"));
    cpSync(this.cwd, snapshotDir, {
      recursive: true,
      dereference: false,
      filter: (src: string) => {
        try {
          return shouldExcludeFromTurnCopy(src, this.cwd.length);
        } catch {
          return true;
        }
      },
    });
    this._baselineSnapshotDir = snapshotDir;
    this._isolatedBaselineDirs.push(snapshotDir);
    this.logger?.info(`[orchestrator] Baseline snapshot created at ${snapshotDir}`);
    return snapshotDir;
  }

  private async _runStructuredTaskValidator(
    config: StructuredValidatorConfig,
    emittedFiles?: Array<{ path: string; content?: string }>,
    baselineDir?: string,
  ): Promise<TaskValidationResult> {
    const started = Date.now();
    const isolatedBase = await this._createIsolatedWorkspace(emittedFiles, baselineDir);
    const cwd = config.cwd ?? isolatedBase;
    if (config.cwd) {
      const rel = relative(isolatedBase, resolve(config.cwd));
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        return {
          status: "error",
          validator: `${config.command} ${config.args.join(" ")}`,
          reason: `validator cwd (${config.cwd}) escapes isolated workspace (${isolatedBase})`,
          durationMs: Date.now() - started,
          details: {},
        };
      }
    }
    const timeoutMs = config.timeoutMs ?? 120000;
    try {
      const { stdout, stderr } = await execFileAsync(config.command, config.args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10,
      });
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      return {
        status: "pass",
        validator: `${config.command} ${config.args.join(" ")}`,
        reason: outputSummary(output) || "validator exited 0",
        durationMs: Date.now() - started,
        details: { exitCode: 0, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) },
      };
    } catch (cause) {
      const errObj = cause as {
        code?: unknown;
        signal?: unknown;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        message?: string;
      };
      const stdout = errObj.stdout ?? "";
      const stderr = errObj.stderr ?? "";
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const timedOut = errObj.killed === true || errObj.signal === "SIGTERM";
      return {
        status: timedOut ? "error" : "fail",
        validator: `${config.command} ${config.args.join(" ")}`,
        reason:
          outputSummary(output) ||
          errObj.message ||
          (timedOut ? "validator timed out" : "validator exited non-zero"),
        durationMs: Date.now() - started,
        details: {
          exitCode: errObj.code ?? null,
          signal: errObj.signal ?? null,
          stdout: stdout.slice(-8000),
          stderr: stderr.slice(-8000),
        },
      };
    }
  }

  private async _runTaskValidator(
    command: string,
    timeoutMs = 120000,
    emittedFiles?: Array<{ path: string; content?: string }>,
    baselineDir?: string,
  ): Promise<TaskValidationResult> {
    if (process.env.ALLOW_UNSAFE_VALIDATOR_SHELL !== "1") {
      return {
        status: "error",
        validator: command,
        reason:
          "validator-shell is disabled: set ALLOW_UNSAFE_VALIDATOR_SHELL=1 to enable raw shell validators",
        durationMs: 0,
        details: {},
      };
    }
    const started = Date.now();
    const isolatedCwd = await this._createIsolatedWorkspace(emittedFiles, baselineDir);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: isolatedCwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 10,
      });
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      return {
        status: "pass",
        validator: command,
        reason: outputSummary(output) || "validator exited 0",
        durationMs: Date.now() - started,
        details: { exitCode: 0, stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) },
      };
    } catch (cause) {
      const errObj = cause as {
        code?: unknown;
        signal?: unknown;
        stdout?: string;
        stderr?: string;
        killed?: boolean;
        message?: string;
      };
      const stdout = errObj.stdout ?? "";
      const stderr = errObj.stderr ?? "";
      const output = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const timedOut = errObj.killed === true || errObj.signal === "SIGTERM";
      return {
        status: timedOut ? "error" : "fail",
        validator: command,
        reason:
          outputSummary(output) ||
          errObj.message ||
          (timedOut ? "validator timed out" : "validator exited non-zero"),
        durationMs: Date.now() - started,
        details: {
          exitCode: errObj.code ?? null,
          signal: errObj.signal ?? null,
          stdout: stdout.slice(-8000),
          stderr: stderr.slice(-8000),
        },
      };
    }
  }

  async gracefulShutdown(): Promise<void> {
    this._shuttingDown = true;
    this._cleanupBaselineDirs();
    this._cleanupIsolatedWorkspace();
    this._cleanupTurnWorkspace();
    await this.sharedEventBus.gracefulShutdown();
    if (this.memoryStore) {
      await this.memoryStore.adapter.persist();
    }
  }

  private async _flushMemory(): Promise<void> {
    if (!this.memoryStore) return;
    await this.memoryStore.adapter.persist();
  }

  async slo(): Promise<SloReport | null> {
    if (!this._sloMonitor) return null;
    return this._sloMonitor.compute();
  }

  /** Get auth/policy/audit SLO report. */
  authPolicySlo(): SloReport {
    return this._authPolicySlo.compute();
  }

  /** Record an auth event for SLO monitoring. */
  recordAuthEvent(
    type: "auth.success" | "auth.failure",
    actorId?: string,
    tenantId?: string,
  ): void {
    this._authPolicySlo.record({ timestamp: Date.now(), type, actorId, tenantId });
  }

  /** Record a policy allow event for SLO monitoring. */
  recordPolicyAllow(actorId?: string, tenantId?: string): void {
    this._authPolicySlo.record({ timestamp: Date.now(), type: "policy.allow", actorId, tenantId });
  }

  healthCheck(): HealthCheckResult {
    return {
      status: this._shuttingDown ? "shutting_down" : ("healthy" as const),
      stats: { ...this.stats },
      eventBus: {
        running: this.sharedEventBus.running,
        inflight: this.sharedEventBus.inflightCount,
        bufferSize: this.sharedEventBus.getBufferSize(),
      },
      memory: this.memoryStore ? "connected" : "none",
      providers: Object.keys(this.modelConfig.providers).length,
    };
  }

  async decomposeTask(
    task: TaskInput,
  ): Promise<
    import("@kirkforge/core-types").Result<import("./types.js").DecompositionResult, Error>
  > {
    if (this._shuttingDown) return err(new Error("Orchestrator is shutting down"));
    const _taskId = task.taskId ?? `task-${Date.now()}`;

    // ── Policy enforcement ──────────────────────────────────────────
    // If a policy engine is configured, check tools and models before
    // proceeding. Deny-by-default: if the policy blocks the action,
    // return an error and audit-log the denial.
    if (this._policyEngine) {
      const providerConfig = this._resolveProvider(null);
      const modelDecision = this._policyEngine.checkModel(providerConfig.defaultModel);
      if (!modelDecision.allowed) {
        this._auditPolicyDeny(
          "model.deny",
          modelDecision.reason,
          modelDecision.policyHash,
          task.actor,
        );
        return err(
          new KirkForgeError("POLICY_DENIED", modelDecision.reason, {
            rule: modelDecision.rule,
            policyHash: modelDecision.policyHash,
          }),
        );
      }
      const profile = detectTaskProfile(task.description);
      const toolDecision = this._policyEngine.checkTool(profile.language ?? "unknown");
      if (!toolDecision.allowed) {
        this._auditPolicyDeny(
          "tool.deny",
          toolDecision.reason,
          toolDecision.policyHash,
          task.actor,
        );
        return err(
          new KirkForgeError("POLICY_DENIED", toolDecision.reason, {
            rule: toolDecision.rule,
            policyHash: toolDecision.policyHash,
          }),
        );
      }
    }

    const effectiveTaskId =
      task.taskId ?? `decomp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const profile = detectTaskProfile(task.description);
    const agent = Agent.fromConfig(
      "decomposer-" + effectiveTaskId,
      this.modelConfig,
      this.decomposeProvider,
      BUILTIN_TEMPLATES["task-decompose"],
    );
    if (!agent.ok) return err(agent.error);

    const brief = {
      description: task.description,
      variables: {
        language: profile.language,
        defaultFile: profile.defaultFile,
      },
    };

    const result = await agent.value.execute(brief);
    if (!result.ok) return err(result.error);

    const emission = result.value;
    const parsed = this._parseDecomposition(emission.content);
    if (!parsed.ok) {
      const retryResult = await agent.value.execute({
        description:
          task.description +
          "\n\n---\nYour previous output could not be parsed as valid JSON. Output ONLY a JSON array, no markdown, no explanation.",
        variables: {
          language: profile.language,
          defaultFile: profile.defaultFile,
        },
      });
      if (!retryResult.ok) return err(retryResult.error);
      const retryParsed = this._parseDecomposition(retryResult.value.content);
      if (!retryParsed.ok)
        return err(new Error("Decomposition failed after retry: " + retryParsed.error.message));
      const rdr = retryParsed.value;
      rdr.rootTask = task.description;
      if (this.memoryStore) {
        this.memoryStore
          .writeDecomposition(effectiveTaskId, task.description, rdr.tasks, profile.language)
          .catch(() => {});
      }
      return ok(rdr);
    }

    const dr = parsed.value;
    dr.rootTask = task.description;
    if (this.memoryStore) {
      this.memoryStore
        .writeDecomposition(effectiveTaskId, task.description, dr.tasks, profile.language)
        .catch(() => {
          // Persistence failure is non-fatal
        });
    }
    return ok(dr);
  }

  async executeDecomposition(
    taskId: string,
    actor?: import("@kirkforge/core-rbac").Actor,
  ): Promise<
    import("@kirkforge/core-types").Result<import("./types.js").DecompositionExecutionResult, Error>
  > {
    if (this._shuttingDown) return err(new Error("Orchestrator is shutting down"));
    if (!this.memoryStore)
      return err(new Error("Memory store required for decomposition execution"));

    const recalled = await this.memoryStore.recallDecomposition(taskId);
    if (!recalled.ok) return err(recalled.error);
    if (!recalled.value || recalled.value.tasks.length === 0) {
      return err(new Error("No decomposition found for taskId: " + taskId));
    }

    // ── Policy enforcement for decomposition ────────────────────────────────
    // Deny-by-default: check ALL unique languages in the decomposition upfront.
    // If any subtask language violates policy, reject the entire decomposition
    // before any work begins. This prevents partial execution and inconsistent state.
    // A decomposition mixing languages is itself suspect — smaller models will
    // hallucinate cross-language subtasks — so we validate every language upfront.
    if (this._policyEngine) {
      const providerConfig = this._resolveProvider(null);
      const modelDecision = this._policyEngine.checkModel(providerConfig.defaultModel);
      if (!modelDecision.allowed) {
        this._auditPolicyDeny("model.deny", modelDecision.reason, modelDecision.policyHash, actor);
        return err(
          new KirkForgeError("POLICY_DENIED", modelDecision.reason, {
            rule: modelDecision.rule,
            policyHash: modelDecision.policyHash,
          }),
        );
      }
      // Collect all unique languages across subtasks
      const languages = new Set<string>(recalled.value.tasks.map((t) => t.language ?? "unknown"));
      for (const lang of languages) {
        const toolDecision = this._policyEngine.checkTool(lang);
        if (!toolDecision.allowed) {
          this._auditPolicyDeny(
            "tool.deny",
            `Tool policy denies language "${lang}" in decomposition: ${toolDecision.reason}`,
            toolDecision.policyHash,
            actor,
          );
          return err(
            new KirkForgeError(
              "POLICY_DENIED",
              `Tool policy denies language "${lang}" in decomposition: ${toolDecision.reason}`,
              { rule: toolDecision.rule, policyHash: toolDecision.policyHash, language: lang },
            ),
          );
        }
      }
    }

    const tasks = recalled.value.tasks;
    // Defensive re-sort: guarantee dependency order even for hand-edited or corrupted stores
    const sorted = this._topologicalSort(tasks);
    if (!sorted.ok)
      return err(
        new Error("Stored decomposition has invalid dependency graph: " + sorted.error.message),
      );
    const ordered = sorted.value;
    const completed = new Map<string, import("./types.js").SubtaskExecutionResult>();
    const results: import("./types.js").SubtaskExecutionResult[] = [];
    let totalTokens = 0;
    const startedAt = Date.now();

    for (const node of ordered) {
      for (const depId of node.dependsOn) {
        const depResult = completed.get(depId);
        if (!depResult)
          return err(
            new Error(
              "Dependency " + depId + " for task " + node.id + " was not found in execution plan",
            ),
          );
        if (!depResult.ok) {
          results.push({
            nodeId: node.id,
            ok: false,
            description: node.description,
            language: node.language,
            durationMs: 0,
            tokensUsed: 0,
            error: "Skipped: dependency " + depId + " failed",
          });
          completed.set(node.id, results[results.length - 1]!);
          continue;
        }
      }

      // Skip if already marked failed by dependency check
      if (completed.has(node.id)) continue;

      const subtaskStartedAt = Date.now();
      const SUBTASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per subtask
      this.logger?.info(
        "[orchestrator] Executing subtask " + node.id + ": " + node.description.slice(0, 60),
      );

      let result: Awaited<ReturnType<typeof this.delegate>>;
      try {
        result = await Promise.race([
          this.delegate({
            taskId: taskId + "--" + node.id,
            description: node.description,
            suppressMemory: false,
            actor,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error("Subtask " + node.id + " timed out after " + SUBTASK_TIMEOUT_MS + "ms"),
                ),
              SUBTASK_TIMEOUT_MS,
            ),
          ),
        ]);
      } catch (e) {
        result = { ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
      }

      if (!result.ok) {
        this.logger?.warn(
          "[orchestrator] Subtask " +
            node.id +
            " failed on first attempt, retrying once: " +
            result.error.message,
        );
        try {
          result = await Promise.race([
            this.delegate({
              taskId: taskId + "--" + node.id + "-r",
              description: node.description,
              suppressMemory: false,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      "Subtask " + node.id + " retry timed out after " + SUBTASK_TIMEOUT_MS + "ms",
                    ),
                  ),
                SUBTASK_TIMEOUT_MS,
              ),
            ),
          ]);
        } catch (e) {
          result = { ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
        }
      }

      if (!result.ok) {
        const sr: import("./types.js").SubtaskExecutionResult = {
          nodeId: node.id,
          ok: false,
          description: node.description,
          language: node.language,
          durationMs: Date.now() - subtaskStartedAt,
          tokensUsed: 0,
          error: result.error.message,
        };
        results.push(sr);
        completed.set(node.id, sr);
        continue;
      }

      const emission = result.value.emission;
      const packet = result.value.packet;
      const verdict = packet?.verification?.overall ?? "unknown";
      const files = extractWrittenFiles(result.value);

      totalTokens += emission.totalTokens;

      const sr: import("./types.js").SubtaskExecutionResult = {
        nodeId: node.id,
        ok: verdict === "pass" || verdict === "warn",
        description: node.description,
        language: node.language,
        durationMs: Date.now() - subtaskStartedAt,
        tokensUsed: emission.totalTokens,
        verdict,
        files: files.length > 0 ? files : undefined,
      };
      results.push(sr);
      completed.set(node.id, sr);
    }

    const succeededCount = results.filter((r) => r.ok).length;
    const executionResult: import("./types.js").DecompositionExecutionResult = {
      rootTask: recalled.value.description,
      results,
      totalSubtasks: ordered.length,
      succeededCount,
      failedCount: ordered.length - succeededCount,
      totalTokens,
      totalDurationMs: Date.now() - startedAt,
    };

    return ok(executionResult);
  }

  private _parseDecomposition(
    raw: string,
  ): import("@kirkforge/core-types").Result<import("./types.js").DecompositionResult, Error> {
    let jsonStr = raw.trim();
    const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlock) jsonStr = codeBlock[1]!.trim();
    // Robust bracket heuristic: [{ is unambiguous JSON array start
    const bracketPair = jsonStr.indexOf("[{");
    if (bracketPair > 0) jsonStr = jsonStr.slice(bracketPair);
    else {
      const braceStart = jsonStr.indexOf("[");
      if (braceStart > 0) jsonStr = jsonStr.slice(braceStart);
    }
    const braceEnd = jsonStr.lastIndexOf("}]");
    if (braceEnd > 0) jsonStr = jsonStr.slice(0, braceEnd + 2);
    else {
      const bEnd = jsonStr.lastIndexOf("]");
      if (bEnd > 0 && bEnd < jsonStr.length - 1) jsonStr = jsonStr.slice(0, bEnd + 1);
    }

    let tasks: unknown[];
    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed))
        return err(new Error("Decomposition output must be a JSON array"));
      tasks = parsed;
    } catch (e) {
      return err(new Error("Failed to parse decomposition JSON: " + (e as Error).message));
    }

    if (tasks.length === 0) return err(new Error("Decomposition produced zero subtasks"));

    // Validate against the canonical Zod schema (single source of truth for shape)
    const decomposeSchema = BUILTIN_TEMPLATES["task-decompose"]?.responseSchema;
    if (decomposeSchema) {
      const zodResult = decomposeSchema.safeParse(tasks);
      if (!zodResult.success) {
        // Model output doesn't match schema — continue with manual coercion below
        this.logger?.warn(
          "[orchestrator] Decomposition failed Zod validation: " +
            zodResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      }
      // If Zod succeeded, tasks is already the correct shape; coercion handles truncation & defaults
    }

    const validComplexities = new Set(["trivial", "simple", "moderate", "complex"]);
    const nodes: import("@kirkforge/core-types").TaskNode[] = [];
    const ids = new Set<string>();

    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i] as Record<string, unknown>;
      const id = String(t.id ?? `task-${i + 1}`);
      if (ids.has(id)) return err(new Error(`Duplicate task id: ${id}`));
      ids.add(id);

      const complexity = String(t.estimatedComplexity ?? "moderate");
      if (!validComplexities.has(complexity))
        return err(new Error(`Invalid complexity "${complexity}" in task ${id}`));

      nodes.push({
        id,
        description: String(t.description ?? "").slice(0, 500),
        language: String(t.language ?? "text"),
        dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).map(String) : [],
        estimatedComplexity: complexity as import("@kirkforge/core-types").EstimatedComplexity,
        outputFiles: Array.isArray(t.outputFiles)
          ? (t.outputFiles as unknown[]).map(String).slice(0, 20)
          : [],
        verificationHint: String(t.verificationHint ?? "").slice(0, 200),
      });
    }

    for (const node of nodes) {
      if (node.dependsOn.includes(node.id))
        return err(new Error(`Task ${node.id} cannot depend on itself`));
      for (const dep of node.dependsOn) {
        if (!ids.has(dep)) return err(new Error(`Task ${node.id} depends on unknown task: ${dep}`));
      }
    }

    if (nodes.length > 24)
      return err(new Error(`Decomposition produced ${nodes.length} subtasks; maximum is 24`));

    const validLanguages = new Set([
      "typescript",
      "javascript",
      "python",
      "shell",
      "cpp",
      "c",
      "rust",
      "go",
      "sql",
      "text",
    ]);
    for (const node of nodes) {
      if (!validLanguages.has(node.language)) {
        // Coerce to text rather than rejecting — the model may output creative values
        // but we log the coercion for debugging
        (node as unknown as Record<string, unknown>).language = "text";
      }
    }

    const sorted = this._topologicalSort(nodes);
    if (!sorted.ok) return err(sorted.error);

    const tokenEstimate =
      sorted.value.length * 400 + sorted.value.reduce((sum, n) => sum + n.description.length, 0);

    return ok({
      rootTask: "", // filled in by decomposeTask
      tasks: sorted.value,
      totalEstimatedTokens: tokenEstimate,
      rationale: `Decomposed into ${sorted.value.length} subtasks (${sorted.value.filter((n) => n.dependsOn.length > 0).length} with dependencies)`,
    });
  }

  private _topologicalSort(
    nodes: import("@kirkforge/core-types").TaskNode[],
  ): import("@kirkforge/core-types").Result<import("@kirkforge/core-types").TaskNode[], Error> {
    const byId = new Map<string, import("@kirkforge/core-types").TaskNode>();
    for (const n of nodes) byId.set(n.id, n);

    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    for (const n of nodes) {
      inDegree.set(n.id, 0);
      adj.set(n.id, []);
    }
    for (const n of nodes) {
      for (const dep of n.dependsOn) {
        adj.get(dep)?.push(n.id);
        inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
      }
    }

    const queue: string[] = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const sorted: import("@kirkforge/core-types").TaskNode[] = [];
    while (queue.length > 0) {
      const id = queue.shift()!;
      sorted.push(byId.get(id)!);
      for (const next of adj.get(id) ?? []) {
        const newDeg = (inDegree.get(next) ?? 1) - 1;
        inDegree.set(next, newDeg);
        if (newDeg === 0) queue.push(next);
      }
    }

    if (sorted.length !== nodes.length)
      return err(new Error("Cycle detected in task dependencies"));
    return ok(sorted);
  }

  private async _finalizeDelegation(
    result: OrchestratorResult,
    taskId: string,
    task: TaskInput,
    mode: string,
    profile: ReturnType<typeof detectTaskProfile>,
    providerConfig: ModelProviderConfig,
    startedAt: number,
  ): Promise<OrchestratorResult> {
    if (!result.ok) return result;

    result.value.providerResolved = this.providerKey;
    for (const sig of result.value.signals) {
      if (sig.kind === "artifact.blocked") {
        const bv = sig.value as ArtifactBlockedSignalValue;
        await this.sharedEventBus.emit({
          kind: "artifact.blocked",
          schemaVersion: "v3",
          sequence: 0,
          streamId: sig.id,
          taskId: sig.taskId,
          value: {
            blockedPaths: bv.blockedPaths,
            ...(bv.parseWarnings ? { parseWarnings: bv.parseWarnings } : {}),
          },
          timestamp: sig.ts,
        });
      } else if (sig.kind === "artifact.unterminated") {
        const uv = sig.value as ArtifactUnterminatedSignalValue;
        await this.sharedEventBus.emit({
          kind: "artifact.unterminated",
          schemaVersion: "v3",
          sequence: 0,
          streamId: sig.id,
          taskId: sig.taskId,
          value: { warnings: uv.warnings },
          timestamp: sig.ts,
        });
      } else if (sig.kind === "artifact.truncated") {
        const tv = sig.value as ArtifactTruncatedSignalValue;
        await this.sharedEventBus.emit({
          kind: "artifact.truncated",
          schemaVersion: "v3",
          sequence: 0,
          streamId: sig.id,
          taskId: sig.taskId,
          value: {
            finishReason: tv.finishReason,
            warnings: tv.warnings,
          },
          timestamp: sig.ts,
        });
      } else if (sig.kind === "artifact.emitted") {
        const ev = sig.value as ArtifactEmittedSignalValue;
        await this.sharedEventBus.emit({
          kind: "artifact.emitted",
          schemaVersion: "v3",
          sequence: 0,
          streamId: sig.id,
          taskId: sig.taskId,
          value: {
            filesWritten: ev.filesWritten,
            totalBytes: ev.totalBytes,
            files: ev.files,
            language: ev.language,
          },
          timestamp: sig.ts,
        });
      }
    }
    const writtenFiles = extractWrittenFiles(result.value);
    await this._runVerifiers(taskId, writtenFiles, profile.language, writtenFiles);
    const packet = this.reducer.reduce(
      taskId,
      0,
      profile.verifierPolicy,
      this._policyEngine?.getHash(),
    );
    result.value.packet = packet;
    if (mode === "artifact" && packet.changes.filesChanged === 0 && !packet.artifactEnforcement) {
      result.value.packet = {
        ...packet,
        verification: { ...packet.verification, overall: "fail" },
        artifactEnforcement: { blocked: 0, blockedPaths: [], status: "fail" },
      };
    }
    if (mode === "schema-contract" && packet.changes.filesChanged === 0 && !packet.emissions) {
      result.value.packet = {
        ...packet,
        verification: { ...packet.verification, overall: "fail" },
        artifactEnforcement: {
          blocked: 0,
          blockedPaths: [],
          status: "fail",
          reason: "schema-contract produced zero emissions",
        },
      };
    }
    if (!task.suppressMemory) {
      const _emissionFiles = extractEmissionFiles(result.value);
      await this._writeMemoryObservation(
        task,
        taskId,
        mode,
        result.value,
        profile.language,
        Date.now() - startedAt,
        _emissionFiles,
      );
    }

    this.stats.totalDelegations++;
    this.stats.totalTokens += result.value.emission.totalTokens;
    return result;
  }
}

// outputSummary and estimateSimpleCost extracted to workspace.ts and cost.ts
