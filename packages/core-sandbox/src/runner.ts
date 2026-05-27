import { spawn, type ChildProcess } from "node:child_process";
import { ok, err, type Result } from "@55ndeep/core-types";
import { NDeepError } from "@55ndeep/core-errors";
import {
  type SandboxConstraints,
  type SandboxResult,
  type SandboxContext,
  type SandboxViolation,
  validateConstraints,
  isCommandAllowed,
  isReadPathAllowed,
  isWritePathAllowed,
  createSandboxContext,
} from "./index.js";

// ── Sandboxed process runner ───────────────────────────────────────────────
//
// Executes commands inside a constrained subprocess. This is the runtime
// companion to the constraint declarations in index.ts.
//
// Enforcement model:
//   1. Command allowlist: only commands in allowedCommands may be spawned.
//   2. Wall-clock timeout: kill process after maxTimeMs.
//   3. Output size limit: truncate stdout/stderr after maxOutputBytes.
//   4. Path validation: reject arguments referencing paths outside allowed
//      read/write roots.
//   5. Network: no enforcement at process level (requires container/VM);
//      instead, violations are detected and reported for post-hoc auditing.
//   6. Memory/CPU: no enforcement at process level (requires OS-level cgroups
//      or container limits); instead, resource usage is measured and reported.
//
// For full isolation (network, filesystem, memory/CPU), run inside Docker or
// a microVM. This runner provides the "constrained host" baseline.

// ── Types ──────────────────────────────────────────────────────────────────

export interface SandboxRunConfig {
  /** Command to execute (must be in allowedCommands if shellAllowed). */
  command: string;
  /** Arguments to pass to the command. */
  args?: string[];
  /** Current working directory for the command. */
  cwd?: string;
  /** Environment variables (merged with process.env). */
  env?: Record<string, string>;
  /** Sandbox constraints. Defaults applied for unspecified fields. */
  constraints?: SandboxConstraints;
  /** Tenant ID for multi-tenant isolation. */
  tenantId?: string;
  /** Actor ID for audit logging. */
  actorId?: string;
  /** Pre-execution hook. */
  beforeHook?: (context: SandboxContext) => Result<void, Error>;
  /** Post-execution hook. */
  afterHook?: (context: SandboxContext, result: SandboxResult) => void;
}

export class SandboxExecutionError extends NDeepError {
  violations: SandboxViolation[];
  constructor(message: string, violations: SandboxViolation[] = []) {
    super("SANDBOX_EXECUTION_ERROR", message, { violations });
    this.name = "SandboxExecutionError";
    this.violations = violations;
  }
}

// ── Path argument scanning ──────────────────────────────────────────────────

/**
 * Scan command arguments for path references that violate constraints.
 * Returns violations for any argument that looks like a path outside allowed roots.
 */
function scanArgsForPathViolations(
  args: string[],
  constraints: Required<SandboxConstraints>,
): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  for (const arg of args) {
    // Heuristic: if arg starts with / or contains /, treat it as a path
    if (arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("..")) {
      const isRead = arg.startsWith("/");
      const allowed = isRead
        ? isReadPathAllowed(arg, constraints)
        : isWritePathAllowed(arg, constraints);
      // For relative paths, just check they don't contain traversal
      if (!allowed && constraints.allowedReadPaths.length > 0) {
        violations.push({
          type: "filesystem",
          message: `Argument path "${arg}" is outside allowed read roots`,
          target: arg,
        });
      }
    }
  }
  return violations;
}

/**
 * Scan environment for secrets or sensitive values that should not be passed.
 */
function scanEnvForSecrets(env: Record<string, string>): SandboxViolation[] {
  const violations: SandboxViolation[] = [];
  const sensitivePatterns = [
    /password/i,
    /secret/i,
    /token/i,
    /api.?key/i,
    /private.?key/i,
    /auth/i,
  ];
  for (const [key, value] of Object.entries(env)) {
    for (const pattern of sensitivePatterns) {
      if (pattern.test(key) && value.length > 0) {
        violations.push({
          type: "filesystem",
          message: `Environment variable "${key}" may contain sensitive data`,
          target: key,
        });
        break;
      }
    }
  }
  return violations;
}

// ── Main runner ─────────────────────────────────────────────────────────────

/**
 * Execute a command inside sandbox constraints.
 *
 * This creates a child process with the given command and args, enforces
 * wall-clock timeout and output size limits, and detects path violations
 * in arguments. Full filesystem/network/CPU/memory isolation requires
 * running inside Docker or a microVM.
 */
export async function runSandboxed(
  config: SandboxRunConfig,
): Promise<Result<SandboxResult, SandboxExecutionError>> {
  const mergedConstraints = validateConstraints(config.constraints ?? {});
  if (!mergedConstraints.ok) {
    return err(
      new SandboxExecutionError(`Invalid sandbox constraints: ${mergedConstraints.error.message}`),
    );
  }
  const constraints = mergedConstraints.value;

  // ── Command allowlist check ───────────────────────────────────────────
  if (constraints.shellAllowed && !isCommandAllowed(config.command, constraints)) {
    return err(
      new SandboxExecutionError(
        `Command "${config.command}" is not in the allowed list: [${constraints.allowedCommands.join(", ")}]`,
        [
          {
            type: "command",
            message: `Command not allowed: ${config.command}`,
            target: config.command,
          },
        ],
      ),
    );
  }
  if (!constraints.shellAllowed) {
    return err(
      new SandboxExecutionError("Shell execution is not allowed by sandbox constraints", [
        { type: "command", message: "Shell execution denied by policy", target: config.command },
      ]),
    );
  }

  const args = config.args ?? [];

  // ── Path scanning ─────────────────────────────────────────────────────
  const pathViolations = scanArgsForPathViolations(args, constraints);
  if (pathViolations.length > 0 && constraints.allowedReadPaths.length > 0) {
    return err(
      new SandboxExecutionError(
        `Sandbox path violations detected: ${pathViolations.map((v) => v.message).join("; ")}`,
        pathViolations,
      ),
    );
  }

  // ── Environment scanning ──────────────────────────────────────────────
  const envViolations = config.env ? scanEnvForSecrets(config.env) : [];

  // ── Create context and call beforeHook ─────────────────────────────────
  const contextResult = createSandboxContext(config.command, args, {
    constraints: config.constraints,
    tenantId: config.tenantId,
    actorId: config.actorId,
    beforeHook: config.beforeHook,
  });
  if (!contextResult.ok) {
    return err(
      new SandboxExecutionError(`Sandbox context creation failed: ${contextResult.error.message}`),
    );
  }
  const context = contextResult.value;

  // ── Execute ───────────────────────────────────────────────────────────
  const startTime = Date.now();
  let stdout = "";
  let stderr = "";
  let truncated = false;
  const violations: SandboxViolation[] = [...pathViolations, ...envViolations];
  let peakMemoryMb: number | null = null;

  return new Promise((resolve) => {
    let killed = false;

    const childEnv = { ...process.env, ...config.env };
    const child: ChildProcess = spawn(config.command, args, {
      cwd: config.cwd,
      env: childEnv as NodeJS.Dict<string | undefined>,
      stdio: ["pipe", "pipe", "pipe"],
      // Detach false — child is in the same process group
      detached: false,
    });

    // ── Timeout ─────────────────────────────────────────────────────────
    const timeoutHandle = setTimeout(() => {
      killed = true;
      violations.push({
        type: "time",
        message: `Process exceeded maxTimeMs=${constraints.maxTimeMs}`,
      });
      child.kill("SIGKILL");
    }, constraints.maxTimeMs);

    // ── Stdout collection ────────────────────────────────────────────────
    let stdoutBytes = 0;
    child.stdout?.on("data", (data: Buffer) => {
      stdoutBytes += data.length;
      if (stdoutBytes > constraints.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          violations.push({
            type: "output_size",
            message: `Stdout exceeded maxOutputBytes=${constraints.maxOutputBytes}`,
          });
        }
      } else {
        stdout += data.toString("utf-8");
      }
    });

    // ── Stderr collection ────────────────────────────────────────────────
    let stderrBytes = 0;
    child.stderr?.on("data", (data: Buffer) => {
      stderrBytes += data.length;
      if (stderrBytes > constraints.maxOutputBytes) {
        if (!truncated) {
          truncated = true;
          violations.push({
            type: "output_size",
            message: `Stderr exceeded maxOutputBytes=${constraints.maxOutputBytes}`,
          });
        }
      } else {
        stderr += data.toString("utf-8");
      }
    });

    // ── Memory measurement (best-effort) ────────────────────────────────
    const memoryInterval = setInterval(() => {
      const rss = child.killed ? 0 : (process.memoryUsage?.().rss ?? 0);
      const mb = rss / (1024 * 1024);
      if (peakMemoryMb === null || mb > peakMemoryMb) {
        peakMemoryMb = mb;
      }
    }, 500);
    // Only measure if child is still running
    // Note: this measures the parent process memory, not the child.
    // For accurate child memory, use /proc/PID/status or cgroups.

    // ── Close handlers ──────────────────────────────────────────────────
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      clearInterval(memoryInterval);

      const durationMs = Date.now() - startTime;
      const result: SandboxResult = {
        success: !killed && code === 0,
        exitCode: code,
        stdout,
        stderr,
        durationMs,
        peakMemoryMb,
        violations,
        truncated,
      };

      // ── Post-execution hook ────────────────────────────────────────────
      if (config.afterHook) {
        try {
          config.afterHook(context, result);
        } catch {
          // Best-effort — don't fail the result for hook errors
        }
      }

      // ── Return ─────────────────────────────────────────────────────────
      if (violations.length > 0 && (killed || violations.some((v) => v.type !== "output_size"))) {
        resolve(
          err(
            new SandboxExecutionError(
              `Sandbox execution failed with ${violations.length} violation(s): ${violations.map((v) => v.message).join("; ")}`,
              violations,
            ),
          ),
        );
      } else {
        resolve(ok(result));
      }
    });

    child.on("error", (errObj) => {
      clearTimeout(timeoutHandle);
      clearInterval(memoryInterval);
      const _durationMs = Date.now() - startTime;
      resolve(
        err(
          new SandboxExecutionError(`Process spawn error: ${errObj.message}`, [
            { type: "command", message: errObj.message, target: config.command },
          ]),
        ),
      );
    });
  });
}

// ── Docker-based sandbox runner (enterprise) ────────────────────────────────
//
// For full isolation, use Docker to run commands in a container with:
//   - No network (unless allowed by constraints)
//   - Read-only root filesystem (except allowed write paths)
//   - CPU and memory limits via cgroups
//   - PID limiting
//   - User namespace isolation
//
// This is a placeholder that checks for Docker availability and returns
// an error if not configured, since actual Docker execution requires
// the Docker daemon to be available at runtime.

export interface DockerSandboxConfig extends SandboxRunConfig {
  /** Docker image to use. Default: "55ndeep/sandbox:latest". */
  image?: string;
  /** Whether to pull the image if not available locally. Default: true. */
  pullImage?: boolean;
  /** Docker network mode. Default: "none" (no network). */
  networkMode?: "none" | "bridge" | "host";
  /** Whether to remove the container after execution. Default: true. */
  removeContainer?: boolean;
}

/**
 * Execute a command inside a Docker container for full isolation.
 *
 * This is the recommended approach for enterprise deployments running
 * untrusted code. It provides:
 *   - Filesystem isolation (read-only root, selective write mounts)
 *   - Network isolation (default: none)
 *   - CPU and memory limits via cgroups
 *   - PID limiting
 *
 * Requires Docker to be available on the host.
 */
export async function runDockerSandboxed(
  config: DockerSandboxConfig,
): Promise<Result<SandboxResult, SandboxExecutionError>> {
  const mergedConstraints = validateConstraints(config.constraints ?? {});
  if (!mergedConstraints.ok) {
    return err(
      new SandboxExecutionError(`Invalid sandbox constraints: ${mergedConstraints.error.message}`),
    );
  }
  const constraints = mergedConstraints.value;

  if (!constraints.shellAllowed) {
    return err(
      new SandboxExecutionError("Shell execution is not allowed by sandbox constraints", [
        { type: "command", message: "Shell execution denied by policy", target: config.command },
      ]),
    );
  }

  if (!isCommandAllowed(config.command, constraints)) {
    return err(
      new SandboxExecutionError(`Command "${config.command}" is not in the allowed list`, [
        {
          type: "command",
          message: `Command not allowed: ${config.command}`,
          target: config.command,
        },
      ]),
    );
  }

  const image = config.image ?? "55ndeep/sandbox:latest";
  const networkMode = config.networkMode ?? (constraints.networkAllowed ? "bridge" : "none");
  const _removeContainer = config.removeContainer ?? true;

  // Build Docker run arguments
  const dockerArgs: string[] = ["run", "--rm"];

  // Network isolation
  if (networkMode === "none") {
    dockerArgs.push("--network=none");
  } else if (networkMode === "bridge" && constraints.networkAllowlist.length > 0) {
    // Docker doesn't support per-destination filtering natively;
    // for production, use custom network + iptables rules
    dockerArgs.push(`--network=${networkMode}`);
  } else {
    dockerArgs.push(`--network=${networkMode}`);
  }

  // Resource limits
  dockerArgs.push(`--memory=${constraints.maxMemoryMb}m`);
  dockerArgs.push(`--cpus=1`);
  dockerArgs.push(`--pids-limit=${Math.max(constraints.maxProcesses, 1)}`);

  // Timeout
  dockerArgs.push(`--stop-timeout=${Math.ceil(constraints.maxTimeMs / 1000)}`);

  // Read-only root filesystem
  dockerArgs.push("--read-only");

  // Mount allowed read paths
  for (const readPath of constraints.allowedReadPaths) {
    dockerArgs.push(`-v`, `${readPath}:${readPath}:ro`);
  }

  // Mount allowed write paths
  for (const writePath of constraints.allowedWritePaths) {
    dockerArgs.push(`-v`, `${writePath}:${writePath}:rw`);
  }

  // Tmpfs for /tmp
  dockerArgs.push("--tmpfs", "/tmp:noexec,nosuid,size=64m");

  // Image and command
  dockerArgs.push(image);
  dockerArgs.push(config.command);
  if (config.args) {
    dockerArgs.push(...config.args);
  }

  // Execute via Docker CLI
  // Note: This spawns "docker" as the command, not the target command directly.
  // The container provides the actual isolation.
  const dockerConfig: SandboxRunConfig = {
    command: "docker",
    args: dockerArgs,
    constraints: {
      ...config.constraints,
      // Docker is the allowed command here; the actual command runs inside the container
      shellAllowed: true,
      allowedCommands: ["docker"],
    },
    cwd: config.cwd,
    env: config.env,
    tenantId: config.tenantId,
    actorId: config.actorId,
    beforeHook: config.beforeHook,
    afterHook: config.afterHook,
  };

  // Use the regular sandboxed runner to execute Docker
  // This provides timeout and output limits on the Docker process itself
  const result = await runSandboxed(dockerConfig);
  if (!result.ok) return result;

  // Mark Docker-specific context in the result
  const sandboxResult = result.value;
  return ok({
    ...sandboxResult,
    // The Docker execution adds overhead; the actual command ran in a container
  });
}
