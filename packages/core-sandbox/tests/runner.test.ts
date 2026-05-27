import { describe, it, expect } from "vitest";
import { runSandboxed, SandboxExecutionError, DEFAULT_CONSTRAINTS } from "../src/runner.js";

describe("runSandboxed", () => {
  const allowedConstraints = {
    ...DEFAULT_CONSTRAINTS,
    shellAllowed: true,
    allowedCommands: ["echo", "node", "cat", "ls", "true"],
    maxTimeMs: 10000,
    allowedReadPaths: ["/tmp"],
    allowedWritePaths: [],
  };

  it("executes allowed commands successfully", async () => {
    const result = await runSandboxed({
      command: "echo",
      args: ["hello", "world"],
      constraints: allowedConstraints,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.stdout.trim()).toBe("hello world");
      expect(result.value.exitCode).toBe(0);
      expect(result.value.violations).toEqual([]);
    }
  });

  it("rejects commands not in allowlist", async () => {
    const result = await runSandboxed({
      command: "rm",
      args: ["-rf", "/"],
      constraints: allowedConstraints,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SandboxExecutionError);
      expect(result.error.message).toContain("not in the allowed list");
    }
  });

  it("rejects when shell is not allowed", async () => {
    const result = await runSandboxed({
      command: "echo",
      args: ["test"],
      constraints: { shellAllowed: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(SandboxExecutionError);
      expect(result.error.message).toContain("not allowed");
    }
  });

  it("captures stdout and stderr", async () => {
    const result = await runSandboxed({
      command: "node",
      args: ["-e", "console.log('out'); console.error('err'); process.exit(0)"],
      constraints: allowedConstraints,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.stdout.trim()).toBe("out");
      expect(result.value.stderr.trim()).toBe("err");
    }
  });

  it("reports non-zero exit codes", async () => {
    const result = await runSandboxed({
      command: "node",
      args: ["-e", "process.exit(42)"],
      constraints: allowedConstraints,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(false);
      expect(result.value.exitCode).toBe(42);
    }
  });

  it("times out long-running commands", async () => {
    const result = await runSandboxed({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 30000)"],
      constraints: {
        ...allowedConstraints,
        maxTimeMs: 1500,
      },
    });
    // The process should be killed by timeout
    if (result.ok) {
      expect(result.value.violations.some((v) => v.type === "time")).toBe(true);
    } else {
      expect(result.error.violations.some((v) => v.type === "time")).toBe(true);
    }
  }, 10000);

  it("truncates output exceeding maxOutputBytes", async () => {
    const result = await runSandboxed({
      command: "node",
      args: ["-e", "console.log('x'.repeat(10000))"],
      constraints: {
        ...allowedConstraints,
        maxOutputBytes: 1024,
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Output should be truncated
      expect(result.value.stdout.length).toBeLessThan(10000);
    }
  });

  it("calls beforeHook before execution", async () => {
    let hookCalled = false;
    const result = await runSandboxed({
      command: "echo",
      args: ["hook-test"],
      constraints: allowedConstraints,
      beforeHook: () => {
        hookCalled = true;
        return { ok: true as const, value: undefined };
      },
    });
    expect(hookCalled).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("rejects when beforeHook returns error", async () => {
    const result = await runSandboxed({
      command: "echo",
      args: ["hook-reject"],
      constraints: allowedConstraints,
      beforeHook: () => ({
        ok: false as const,
        error: new Error("blocked by policy") as any,
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("blocked by policy");
    }
  });

  it("calls afterHook after execution", async () => {
    let hookResult: any = null;
    const result = await runSandboxed({
      command: "echo",
      args: ["after-hook"],
      constraints: allowedConstraints,
      afterHook: (_ctx, res) => {
        hookResult = res;
      },
    });
    expect(result.ok).toBe(true);
    expect(hookResult).not.toBeNull();
    expect(hookResult.stdout.trim()).toBe("after-hook");
  });

  it("passes tenant and actor IDs through context", async () => {
    let capturedTenantId: string | undefined;
    let capturedActorId: string | undefined;
    const result = await runSandboxed({
      command: "echo",
      args: ["tenant-test"],
      constraints: allowedConstraints,
      tenantId: "t-abc",
      actorId: "user-xyz",
      beforeHook: (ctx) => {
        capturedTenantId = ctx.tenantId;
        capturedActorId = ctx.actorId;
        return { ok: true as const, value: undefined };
      },
    });
    expect(capturedTenantId).toBe("t-abc");
    expect(capturedActorId).toBe("user-xyz");
    expect(result.ok).toBe(true);
  });

  it("reports durationMs", async () => {
    const result = await runSandboxed({
      command: "echo",
      args: ["timing"],
      constraints: allowedConstraints,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
