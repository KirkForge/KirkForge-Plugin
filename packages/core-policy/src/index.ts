import { ok, err, type Result } from "@55ndeep/core-types";
import { NDeepError, ValidationError } from "@55ndeep/core-errors";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Policy engine for 55NDeep ─────────────────────────────────────────────────
//
// Deny-by-default policy enforcement. Every action must be explicitly allowed
// by policy, or it is denied. Policy is loaded from a JSON file or fetched from
// a policy service.
//
// Policy covers:
//   - Tool allowlists: which external tools can run
//   - Model governance: which AI models/providers are approved
//   - Workspace containment: which directory roots are allowed
//   - Execution controls: network, timeouts, resource limits
//   - Tenant overrides: per-tenant policy adjustments

// ── Policy schema ──────────────────────────────────────────────────────────

export interface Policy {
  /** Policy version for hash-based verification. */
  version: number;
  /** Hash of the policy content (computed on load, used for audit). */
  hash?: string;
  /** Human-readable name. */
  name?: string;
  /** Tool allowlists and denylists. */
  tools: ToolPolicy;
  /** Model governance. */
  models: ModelPolicy;
  /** Workspace containment. */
  workspaces: WorkspacePolicy;
  /** Execution controls. */
  execution: ExecutionPolicy;
  /** Per-tenant overrides. Keyed by tenant ID. */
  tenantOverrides?: Record<string, Partial<Policy>>;
}

export interface ToolPolicy {
  /** Allowed tool names. If set, ONLY these tools may run. */
  allowed: string[];
  /** Explicitly denied tool names. Takes precedence over allowed. */
  denied: string[];
  /** Maximum concurrent tool invocations. Default: 4. */
  maxConcurrent?: number;
}

export interface ModelPolicy {
  /** Allowed model identifiers (e.g. "claude-sonnet-4-20250514", "gpt-4o"). */
  allowed: string[];
  /** Allowed provider keys (e.g. "openai", "anthropic", "local-ollama"). */
  allowedProviders: string[];
  /** Maximum tokens per request. Default: unlimited. */
  maxTokensPerRequest?: number;
}

export interface WorkspacePolicy {
  /** Allowed root directories for workspace operations. */
  allowedRoots: string[];
  /** Maximum workspace path depth. Default: 10. */
  maxPathDepth?: number;
  /** Whether symlinks are allowed in workspace paths. Default: false. */
  allowSymlinks?: boolean;
}

export interface ExecutionPolicy {
  /** Whether network egress is allowed during tool execution. Default: false. */
  networkAllowed: boolean;
  /** Maximum runtime per tool invocation in seconds. Default: 60. */
  maxRuntimeSeconds?: number;
  /** Maximum memory per tool invocation in MB. Default: 512. */
  maxMemoryMb?: number;
  /** Whether to allow shell command execution. Default: false. */
  shellAllowed?: boolean;
  /** Allowed shell commands (only relevant if shellAllowed is true). */
  allowedCommands?: string[];
}

export interface PolicyDecision {
  /** Whether the action was allowed. */
  allowed: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** Policy hash at the time of the decision. */
  policyHash: string;
  /** Timestamp of the decision. */
  timestamp: string;
  /** The rule that triggered the decision. */
  rule: string;
}

// ── Policy errors ───────────────────────────────────────────────────────────

export class PolicyDeniedError extends NDeepError {
  decision: PolicyDecision;
  constructor(decision: PolicyDecision) {
    super("POLICY_DENIED", decision.reason, {
      rule: decision.rule,
      policyHash: decision.policyHash,
    });
    this.name = "PolicyDeniedError";
    this.decision = decision;
  }
}

export class PolicyLoadError extends NDeepError {
  constructor(message: string, cause?: string) {
    super("POLICY_LOAD_ERROR", message, { cause });
    this.name = "PolicyLoadError";
  }
}

// ── Default policy (most restrictive) ───────────────────────────────────────

export const DEFAULT_POLICY: Policy = {
  version: 1,
  name: "default-deny",
  tools: {
    allowed: [], // deny all by default
    denied: [],
    maxConcurrent: 4,
  },
  models: {
    allowed: [], // deny all by default
    allowedProviders: [],
    maxTokensPerRequest: undefined,
  },
  workspaces: {
    allowedRoots: [], // deny all by default
    maxPathDepth: 10,
    allowSymlinks: false,
  },
  execution: {
    networkAllowed: false,
    maxRuntimeSeconds: 60,
    maxMemoryMb: 512,
    shellAllowed: false,
    allowedCommands: [],
  },
};

// ── Policy engine ──────────────────────────────────────────────────────────

export class PolicyEngine {
  private policy: Policy;
  private hash: string;

  constructor(initial?: Policy) {
    this.policy = initial ?? structuredClone(DEFAULT_POLICY);
    this.hash = computeHash(JSON.stringify(this.policy));
  }

  /** Load policy from a JSON file. */
  loadFromFile(filePath: string): Result<void, PolicyLoadError> {
    const abs = resolve(filePath);
    if (!existsSync(abs)) {
      return err(new PolicyLoadError(`Policy file not found: ${abs}`));
    }
    try {
      const raw = readFileSync(abs, "utf-8");
      const parsed = JSON.parse(raw);
      const validated = validatePolicy(parsed);
      if (!validated.ok) {
        return err(new PolicyLoadError(`Invalid policy file: ${validated.error.message}`));
      }
      this.policy = validated.value;
      this.hash = computeHash(raw);
      return ok(undefined);
    } catch (e) {
      return err(
        new PolicyLoadError(
          `Failed to load policy from ${abs}`,
          e instanceof Error ? e.message : String(e),
        ),
      );
    }
  }

  /** Get current policy (immutable copy). */
  getPolicy(): Policy {
    return structuredClone(this.policy);
  }

  /** Get current policy hash. */
  getHash(): string {
    return this.hash;
  }

  // ── Enforcement methods ────────────────────────────────────────────────

  /** Check if a tool is allowed. */
  checkTool(toolName: string): PolicyDecision {
    const policy = this.policy.tools;

    // Denied list takes precedence
    if (policy.denied.includes(toolName)) {
      return deny("tool_denied_list", `Tool "${toolName}" is on the denied list`, this.hash);
    }

    // If allowed list is empty, deny everything (deny-by-default)
    if (policy.allowed.length === 0) {
      return deny(
        "tool_no_allowlist",
        `No tool allowlist configured; tool "${toolName}" denied by default`,
        this.hash,
      );
    }

    if (!policy.allowed.includes(toolName)) {
      return deny("tool_not_allowed", `Tool "${toolName}" is not on the allowed list`, this.hash);
    }

    return allow("tool_allowed", `Tool "${toolName}" is allowed`, this.hash);
  }

  /** Check if a model is allowed. */
  checkModel(modelId: string, providerKey?: string): PolicyDecision {
    const policy = this.policy.models;

    if (policy.allowed.length === 0) {
      return deny(
        "model_no_allowlist",
        `No model allowlist configured; model "${modelId}" denied by default`,
        this.hash,
      );
    }

    if (!policy.allowed.includes(modelId)) {
      return deny("model_not_allowed", `Model "${modelId}" is not on the allowed list`, this.hash);
    }

    if (
      providerKey &&
      policy.allowedProviders.length > 0 &&
      !policy.allowedProviders.includes(providerKey)
    ) {
      return deny(
        "provider_not_allowed",
        `Provider "${providerKey}" is not on the allowed provider list`,
        this.hash,
      );
    }

    return allow("model_allowed", `Model "${modelId}" is allowed`, this.hash);
  }

  /** Check if a workspace path is contained within allowed roots. */
  checkWorkspace(workspacePath: string): PolicyDecision {
    const policy = this.policy.workspaces;

    if (policy.allowedRoots.length === 0) {
      return deny(
        "workspace_no_allowlist",
        `No workspace allowlist configured; path "${workspacePath}" denied by default`,
        this.hash,
      );
    }

    const abs = resolve(workspacePath);
    const contained = policy.allowedRoots.some((root) => {
      const absRoot = resolve(root);
      return abs.startsWith(absRoot);
    });

    if (!contained) {
      return deny(
        "workspace_not_allowed",
        `Path "${workspacePath}" is not within any allowed root`,
        this.hash,
      );
    }

    // Path depth check
    if (policy.maxPathDepth) {
      const _depth = abs.split("/").length - resolve(workspacePath).split("/").length;
      // relative depth from allowed root
      const matchedRoot = policy.allowedRoots.find((root) => abs.startsWith(resolve(root)));
      if (matchedRoot) {
        const relDepth = abs.slice(resolve(matchedRoot).length).split("/").filter(Boolean).length;
        if (relDepth > (policy.maxPathDepth ?? 10)) {
          return deny(
            "workspace_path_too_deep",
            `Path "${workspacePath}" exceeds max depth ${policy.maxPathDepth}`,
            this.hash,
          );
        }
      }
    }

    if (!policy.allowSymlinks) {
      // Symlink check is done at runtime in the orchestrator's path-safety module
      // This policy flag is the declaration of intent
    }

    return allow("workspace_allowed", `Path "${workspacePath}" is within allowed roots`, this.hash);
  }

  /** Check if execution parameters are within policy limits. */
  checkExecution(params: {
    networkRequired?: boolean;
    runtimeSeconds?: number;
    memoryMb?: number;
    command?: string;
  }): PolicyDecision[] {
    const decisions: PolicyDecision[] = [];
    const policy = this.policy.execution;

    // Network
    if (params.networkRequired && !policy.networkAllowed) {
      decisions.push(
        deny("execution_network_denied", "Network egress is denied by policy", this.hash),
      );
    }

    // Runtime
    if (
      params.runtimeSeconds &&
      policy.maxRuntimeSeconds &&
      params.runtimeSeconds > policy.maxRuntimeSeconds
    ) {
      decisions.push(
        deny(
          "execution_runtime_exceeded",
          `Runtime ${params.runtimeSeconds}s exceeds max ${policy.maxRuntimeSeconds}s`,
          this.hash,
        ),
      );
    }

    // Memory
    if (params.memoryMb && policy.maxMemoryMb && params.memoryMb > policy.maxMemoryMb) {
      decisions.push(
        deny(
          "execution_memory_exceeded",
          `Memory ${params.memoryMb}MB exceeds max ${policy.maxMemoryMb}MB`,
          this.hash,
        ),
      );
    }

    // Shell commands
    if (params.command) {
      if (!policy.shellAllowed) {
        decisions.push(
          deny("execution_shell_denied", "Shell command execution is denied by policy", this.hash),
        );
      } else if (
        policy.allowedCommands &&
        policy.allowedCommands.length > 0 &&
        !policy.allowedCommands.includes(params.command)
      ) {
        decisions.push(
          deny(
            "execution_command_denied",
            `Shell command "${params.command}" is not allowed`,
            this.hash,
          ),
        );
      }
    }

    return decisions.length > 0
      ? decisions
      : [allow("execution_allowed", "Execution parameters within policy limits", this.hash)];
  }

  /** Get tenant-overridden policy. Returns a new Policy with tenant overrides merged. */
  forTenant(tenantId: string): Policy {
    const overrides = this.policy.tenantOverrides?.[tenantId];
    if (!overrides) return this.getPolicy();

    // Deep merge base policy with tenant overrides
    const merged = deepMergePolicy(this.policy, overrides);
    return merged;
  }
}

// ── Policy validation ──────────────────────────────────────────────────────

function validatePolicy(raw: unknown): Result<Policy, ValidationError> {
  if (typeof raw !== "object" || raw === null) {
    return err(new ValidationError("Policy must be an object"));
  }
  const p = raw as Record<string, unknown>;

  // Version
  if (typeof p.version !== "number" || p.version < 1) {
    return err(new ValidationError("Policy version must be a positive integer"));
  }

  // Tools
  if (!p.tools || typeof p.tools !== "object") {
    return err(new ValidationError("Policy must have a 'tools' object"));
  }
  const tools = p.tools as Record<string, unknown>;
  if (!Array.isArray(tools.allowed)) {
    return err(new ValidationError("Policy tools.allowed must be an array"));
  }
  if (!Array.isArray(tools.denied)) {
    return err(new ValidationError("Policy tools.denied must be an array"));
  }

  // Models
  if (!p.models || typeof p.models !== "object") {
    return err(new ValidationError("Policy must have a 'models' object"));
  }
  const models = p.models as Record<string, unknown>;
  if (!Array.isArray(models.allowed)) {
    return err(new ValidationError("Policy models.allowed must be an array"));
  }
  if (!Array.isArray(models.allowedProviders)) {
    return err(new ValidationError("Policy models.allowedProviders must be an array"));
  }

  // Workspaces
  if (!p.workspaces || typeof p.workspaces !== "object") {
    return err(new ValidationError("Policy must have a 'workspaces' object"));
  }
  const workspaces = p.workspaces as Record<string, unknown>;
  if (!Array.isArray(workspaces.allowedRoots)) {
    return err(new ValidationError("Policy workspaces.allowedRoots must be an array"));
  }

  // Execution
  if (!p.execution || typeof p.execution !== "object") {
    return err(new ValidationError("Policy must have an 'execution' object"));
  }

  return ok({
    version: p.version as number,
    name: p.name as string | undefined,
    tools: {
      allowed: tools.allowed as string[],
      denied: tools.denied as string[],
      maxConcurrent: tools.maxConcurrent as number | undefined,
    },
    models: {
      allowed: models.allowed as string[],
      allowedProviders: models.allowedProviders as string[],
      maxTokensPerRequest: models.maxTokensPerRequest as number | undefined,
    },
    workspaces: {
      allowedRoots: workspaces.allowedRoots as string[],
      maxPathDepth: workspaces.maxPathDepth as number | undefined,
      allowSymlinks: workspaces.allowSymlinks as boolean | undefined,
    },
    execution: {
      networkAllowed: (p.execution as Record<string, unknown>).networkAllowed as boolean,
      maxRuntimeSeconds: (p.execution as Record<string, unknown>).maxRuntimeSeconds as
        | number
        | undefined,
      maxMemoryMb: (p.execution as Record<string, unknown>).maxMemoryMb as number | undefined,
      shellAllowed: (p.execution as Record<string, unknown>).shellAllowed as boolean | undefined,
      allowedCommands: (p.execution as Record<string, unknown>).allowedCommands as
        | string[]
        | undefined,
    },
    tenantOverrides: p.tenantOverrides as Record<string, Partial<Policy>> | undefined,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

function computeHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 16);
}

function deny(rule: string, reason: string, policyHash: string): PolicyDecision {
  return { allowed: false, reason, policyHash, timestamp: new Date().toISOString(), rule };
}

function allow(rule: string, reason: string, policyHash: string): PolicyDecision {
  return { allowed: true, reason, policyHash, timestamp: new Date().toISOString(), rule };
}

function deepMergePolicy(base: Policy, override: Partial<Policy>): Policy {
  const result = structuredClone(base);
  if (override.tools) {
    result.tools = { ...result.tools, ...override.tools };
  }
  if (override.models) {
    result.models = { ...result.models, ...override.models };
  }
  if (override.workspaces) {
    result.workspaces = { ...result.workspaces, ...override.workspaces };
  }
  if (override.execution) {
    result.execution = { ...result.execution, ...override.execution };
  }
  return result;
}
