import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@kirkforge/core-events";
import { StateReducer } from "../src/reducer.js";
import { classifyTask } from "../src/classifier.js";
import { decideCorrection } from "../src/correction-loop.js";
import { executeHardPrompt } from "../src/modes.js";
import { executeArtifact, parseArtifacts, writeArtifacts } from "../src/artifact-mode.js";
import { sha256Of } from "../src/path-safety.js";
import { detectTaskProfile } from "../src/task-profile.js";
import type { EmissionSchema } from "../src/task-profile.js";
import { createVerificationEmitters } from "../src/emitter-factory.js";
import type { VerifierPolicy } from "@kirkforge/correction-core";
import { Orchestrator } from "../src/index.js";
import type { OrchestratorConfig } from "../src/index.js";
import { InMemoryAdapter, MemoryStore } from "@kirkforge/memory-palace";
import type { TaskInput } from "../src/types.js";
import { ok } from "@kirkforge/core-types";

describe("StateReducer", () => {
  it("reduces signals to packet", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s1",
      taskId: "t1",
      value: {
        status: "fail",
        errors: 2,
        warnings: 1,
        filesScanned: 5,
        durationMs: 100,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s1",
      taskId: "t1",
      value: { status: "pass", errors: 0, durationMs: 50, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.changes",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s1",
      taskId: "t1",
      value: {
        filesChanged: 3,
        paths: ["a.ts", "b.ts"],
        insertions: 10,
        deletions: 2,
        durationMs: 30,
      },
      timestamp: "now",
    });
    const p = reducer.reduce("t1", 0);
    expect(p.verification.lint.errors).toBe(2);
    expect(p.changes.filesChanged).toBe(3);
    expect(p.verification.overall).toBe("fail");
  });

  it("returns pass when clean", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s2",
      taskId: "t2",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 3,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s2",
      taskId: "t2",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s2",
      taskId: "t2",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 3,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s2",
      taskId: "t2",
      value: {
        status: "pass",
        edgeCount: 0,
        newEdges: 0,
        brokenEdges: 0,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    expect(reducer.reduce("t2", 0).verification.overall).toBe("pass");
  });

  it("fails closed when verifier signals are missing", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s3",
      taskId: "t3",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    expect(reducer.reduce("t3", 0).verification.overall).toBe("fail");
  });

  it("fails closed on explicit verifier error", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s4",
      taskId: "t4",
      value: {
        status: "error",
        error: "eslint config exploded",
        errors: 1,
        warnings: 0,
        filesScanned: 0,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s4",
      taskId: "t4",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s4",
      taskId: "t4",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s4",
      taskId: "t4",
      value: {
        status: "pass",
        edgeCount: 0,
        newEdges: 0,
        brokenEdges: 0,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    expect(reducer.reduce("t4", 0).verification.overall).toBe("fail");
  });

  it("fails closed when artifact.blocked signal exists", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s5",
      taskId: "t5",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s5",
      taskId: "t5",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s5",
      taskId: "t5",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s5",
      taskId: "t5",
      value: {
        status: "pass",
        edgeCount: 0,
        newEdges: 0,
        brokenEdges: 0,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "artifact.blocked",
      schemaVersion: "v3",
      sequence: 5,
      streamId: "s5",
      taskId: "t5",
      value: { blockedPaths: [{ path: "output.ts", reason: "python task cannot emit output.ts" }] },
      timestamp: "now",
    });
    const packet = reducer.reduce("t5", 0);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.artifactEnforcement).toBeDefined();
    expect(packet.artifactEnforcement?.status).toBe("fail");
    expect(packet.artifactEnforcement?.blocked).toBe(1);
    expect(packet.artifactEnforcement?.blockedPaths[0]?.path).toBe("output.ts");
    expect(packet.artifactEnforcement?.blockedPaths[0]?.reason).toBe(
      "python task cannot emit output.ts",
    );
  });

  it("fails when required verifier is missing (with policy)", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types"], advisory: ["graph"] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s7",
      taskId: "t7",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t7", 0, policy);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.verifierPolicy).toBeDefined();
    expect(packet.verifierPolicy?.missingRequired).toContain("types");
    expect(packet.verifierPolicy?.skippedRequired).toEqual([]);
  });

  it("fails when required verifier is skipped (with policy)", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types"], advisory: ["graph"] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s8",
      taskId: "t8",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s8",
      taskId: "t8",
      value: { status: "skipped", errors: 0, durationMs: 0, details: [] },
      timestamp: "now",
    });
    const packet = reducer.reduce("t8", 0, policy);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.verifierPolicy?.skippedRequired).toContain("types");
    expect(packet.verifierPolicy?.missingRequired).toEqual([]);
  });

  it("advisory skipped graph does not fail by itself when required verifiers pass", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types", "security"], advisory: ["graph"] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s9",
      taskId: "t9",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s9",
      taskId: "t9",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s9",
      taskId: "t9",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s9",
      taskId: "t9",
      value: {
        status: "skipped",
        edgeCount: 0,
        newEdges: 0,
        brokenEdges: 0,
        cycles: 0,
        durationMs: 0,
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t9", 0, policy);
    expect(packet.verification.overall).toBe("pass");
    expect(packet.verifierPolicy?.missingRequired).toEqual([]);
    expect(packet.verifierPolicy?.skippedRequired).toEqual([]);
  });

  it("no policy preserves old fail-closed behavior (missing verifiers cause error status)", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s10",
      taskId: "t10",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t10", 0);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.verifierPolicy).toBeUndefined();
  });

  it("missing advisory slots do not force fail when policy is provided", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types"], advisory: ["security", "graph"] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s11",
      taskId: "t11",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s11",
      taskId: "t11",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    const packet = reducer.reduce("t11", 0, policy);
    expect(packet.verification.overall).toBe("pass");
    expect(packet.verifierPolicy?.missingRequired).toEqual([]);
    expect(packet.verifierPolicy?.skippedRequired).toEqual([]);
    expect(packet.verification.security.status).toBe("skipped");
    expect(packet.verification.lint.errors).toBe(0);
    expect(packet.verification.types.errors).toBe(0);
  });

  it("advisory verifier with critical findings still fails even when advisory", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types"], advisory: ["security"] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s12",
      taskId: "t12",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s12",
      taskId: "t12",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s12",
      taskId: "t12",
      value: {
        status: "fail",
        findings: 3,
        critical: 1,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t12", 0, policy);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.verification.security.critical).toBe(1);
  });

  it("no policy with only passing lint/types still fails (fail-closed)", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s13",
      taskId: "t13",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s13",
      taskId: "t13",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    const packet = reducer.reduce("t13", 0);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.verifierPolicy).toBeUndefined();
  });

  it("no policy with graph brokenEdges still fails (backward compatible)", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s14",
      taskId: "t14",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s14",
      taskId: "t14",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s14",
      taskId: "t14",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s14",
      taskId: "t14",
      value: {
        status: "fail",
        edgeCount: 5,
        newEdges: 0,
        brokenEdges: 2,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t14", 0);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.graph.brokenEdges).toBe(2);
  });

  it("graph advisory with brokenEdges produces warn, not fail", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types", "security"], advisory: ["graph"] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s15",
      taskId: "t15",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s15",
      taskId: "t15",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s15",
      taskId: "t15",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s15",
      taskId: "t15",
      value: {
        status: "fail",
        edgeCount: 5,
        newEdges: 0,
        brokenEdges: 3,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t15", 0, policy);
    expect(packet.verification.overall).toBe("warn");
    expect(packet.graph.brokenEdges).toBe(3);
  });

  it("graph required with brokenEdges fails", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = {
      required: ["lint", "types", "security", "graph"],
      advisory: [],
    };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s16",
      taskId: "t16",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s16",
      taskId: "t16",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.security",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s16",
      taskId: "t16",
      value: {
        status: "pass",
        findings: 0,
        critical: 0,
        high: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 4,
      streamId: "s16",
      taskId: "t16",
      value: {
        status: "fail",
        edgeCount: 5,
        newEdges: 0,
        brokenEdges: 2,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t16", 0, policy);
    expect(packet.verification.overall).toBe("fail");
    expect(packet.graph.brokenEdges).toBe(2);
  });

  it("graph absent from policy with brokenEdges does not affect overall", async () => {
    const bus = new EventBus();
    const reducer = new StateReducer(bus);
    const policy: VerifierPolicy = { required: ["lint", "types"], advisory: [] };
    await bus.emit({
      kind: "verify.lint",
      schemaVersion: "v3",
      sequence: 1,
      streamId: "s17",
      taskId: "t17",
      value: {
        status: "pass",
        errors: 0,
        warnings: 0,
        filesScanned: 1,
        durationMs: 10,
        details: [],
      },
      timestamp: "now",
    });
    await bus.emit({
      kind: "verify.types",
      schemaVersion: "v3",
      sequence: 2,
      streamId: "s17",
      taskId: "t17",
      value: { status: "pass", errors: 0, durationMs: 10, details: [] },
      timestamp: "now",
    });
    await bus.emit({
      kind: "state.graph",
      schemaVersion: "v3",
      sequence: 3,
      streamId: "s17",
      taskId: "t17",
      value: {
        status: "fail",
        edgeCount: 5,
        newEdges: 0,
        brokenEdges: 4,
        cycles: 0,
        durationMs: 10,
      },
      timestamp: "now",
    });
    const packet = reducer.reduce("t17", 0, policy);
    expect(packet.verification.overall).toBe("pass");
    expect(packet.graph.brokenEdges).toBe(4);
  });

  it("task profile has verifierPolicy for each language", () => {
    const languages = [
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
    ] as const;
    for (const lang of languages) {
      const profile = detectTaskProfile(`write a ${lang} program`);
      expect(profile.verifierPolicy).toBeDefined();
      expect(profile.verifierPolicy.required).toBeDefined();
      expect(profile.verifierPolicy.advisory).toBeDefined();
      expect(Array.isArray(profile.verifierPolicy.required)).toBe(true);
      expect(Array.isArray(profile.verifierPolicy.advisory)).toBe(true);
    }
  });

  it("typescript profile requires lint, types, security; advisory graph", () => {
    const profile = detectTaskProfile("write a typescript server endpoint");
    expect(profile.verifierPolicy.required).toEqual(["lint", "types", "security"]);
    expect(profile.verifierPolicy.advisory).toEqual(["graph"]);
  });

  it("python profile requires lint, types; advisory security, graph", () => {
    const profile = detectTaskProfile("write a python pandas script");
    expect(profile.verifierPolicy.required).toEqual(["lint", "types"]);
    expect(profile.verifierPolicy.advisory).toEqual(["security", "graph"]);
  });

  it("detectTaskProfile returns EmissionSchema-conforming object for python", () => {
    const schema: EmissionSchema = detectTaskProfile("write a python pandas script");
    expect(schema.language).toBe("python");
    expect(schema.defaultFile).toBe("solution.py");
    expect(schema.forbiddenExtensions).toContain(".ts");
    expect(schema.verifierPolicy.required).toContain("lint");
    expect(schema.verifierPolicy.required).toContain("types");
    expect(schema.verifierPolicy.advisory).toContain("security");
    expect(schema.fenceLanguages).toContain("python");
    expect(typeof schema.checkCommand).toBe("string");
    expect(typeof schema.promptHint).toBe("string");
    expect(Array.isArray(schema.allowedExtensions)).toBe(true);
    expect(Array.isArray(schema.forbiddenExtensions)).toBe(true);
  });
});

describe("classifyTask", () => {
  it("audit → schema-contract", () => {
    expect(classifyTask({ description: "audit the security report" }).mode).toBe("schema-contract");
  });
  it("file creation → artifact", () => {
    expect(classifyTask({ description: "generate a component file" }).mode).toBe("artifact");
  });
  it("artifact overrides schema-contract for code-gen with mixed keywords", () => {
    expect(classifyTask({ description: "write a TypeScript server with validation" }).mode).toBe(
      "artifact",
    );
  });
  it("defaults to hard-prompt", () => {
    expect(classifyTask({ description: "hello world" }).mode).toBe("hard-prompt");
  });
  it("user override respected", () => {
    const d = classifyTask({ description: "build", modeOverride: "artifact" });
    expect(d.mode).toBe("artifact");
    expect(d.autoRouted).toBe(false);
  });
});

describe("task profile routing", () => {
  it("detects Python and shell tasks before prompting", () => {
    expect(detectTaskProfile("fix broken-python pandas csv-to-parquet script").language).toBe(
      "python",
    );
    expect(detectTaskProfile("create-bucket using aws cli shell commands").language).toBe("shell");
  });

  it("persists unlabelled code blocks with the detected default extension", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-test-"));
    const agent = {
      execute: async () => ({
        ok: true,
        value: {
          agentId: "agent-test",
          content: "```\nprint('ok')\n```",
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          model: "stub",
          format: "hard-prompt",
        },
      }),
    };

    try {
      const result = await executeHardPrompt(
        agent as any,
        { description: "fix broken-python" },
        "task-1",
        cwd,
        detectTaskProfile("fix broken-python"),
      );
      expect(result.ok).toBe(true);
      expect(readFileSync(join(cwd, "solution.py"), "utf-8")).toContain("print('ok')");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("strips outer markdown fences from artifact file contents", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-test-"));
    const agent = {
      execute: async () => ({
        ok: true,
        value: {
          agentId: "agent-test",
          content: JSON.stringify({
            type: "file_write",
            path: "solution.py",
            sha256: sha256Of("print('ok')\n"),
            content_b64: Buffer.from("print('ok')\n", "utf-8").toString("base64"),
          }),
          promptTokens: 1,
          completionTokens: 1,
          totalTokens: 2,
          model: "stub",
          format: "artifact",
        },
      }),
    };

    try {
      const result = await executeArtifact(
        agent as any,
        { description: "write solution.py" },
        "task-artifact",
        cwd,
        detectTaskProfile("broken-python"),
      );
      expect(result.ok).toBe(true);
      expect(readFileSync(join(cwd, "solution.py"), "utf-8")).toBe("print('ok')\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("hard-prompt artifact enforcement", () => {
  const pythonProfile = detectTaskProfile("write a python script");

  it("allows valid Python file in hard-prompt mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-hp-valid-"));
    try {
      const content = "```python\nprint('hello')\n```";
      const result = await executeHardPrompt(
        {
          execute: async () => ({
            ok: true,
            value: {
              agentId: "a",
              content,
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
              model: "stub",
              format: "hard-prompt",
            },
          }),
        } as any,
        { description: "fix broken-python" },
        "hp-valid",
        cwd,
        pythonProfile,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fileSignal = result.value.signals.find((s) => s.kind === "files.written");
        expect(fileSignal).toBeDefined();
        expect((fileSignal as any).value.files.length).toBeGreaterThanOrEqual(1);
        const paths = (fileSignal as any).value.files.map((f: any) => f.path);
        expect(paths).toContain("solution.py");
      }
      expect(readFileSync(join(cwd, "solution.py"), "utf-8")).toContain("print('hello')");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("writes to profile default file regardless of code block language annotation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-hp-wrongext-"));
    try {
      const content = "```typescript\n// see output.ts for details\nconsole.log('hi')\n```";
      const result = await executeHardPrompt(
        {
          execute: async () => ({
            ok: true,
            value: {
              agentId: "a",
              content,
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
              model: "stub",
              format: "hard-prompt",
            },
          }),
        } as any,
        { description: "write a python script" },
        "hp-wrongext",
        cwd,
        pythonProfile,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fileSignal = result.value.signals.find((s) => s.kind === "files.written");
        expect(fileSignal).toBeDefined();
        const paths = (fileSignal as any).value.files.map((f: any) => f.path);
        expect(paths).toContain("solution.py");
      }
      // Verify file was written to profile default path, not guessed from content
      expect(existsSync(join(cwd, "solution.py"))).toBe(true);
      expect(existsSync(join(cwd, "output.ts"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks path traversal in hard-prompt mode", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-hp-traversal-"));
    try {
      const content = "```python\nimport os\n```";
      const result = await executeHardPrompt(
        {
          execute: async () => ({
            ok: true,
            value: {
              agentId: "a",
              content,
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
              model: "stub",
              format: "hard-prompt",
            },
          }),
        } as any,
        { description: "write a python script" },
        "hp-traversal",
        cwd,
        pythonProfile,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const written = result.value.signals.find((s) => s.kind === "files.written");
        expect(written).toBeDefined();
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("hard-prompt always uses profile default file as output path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-hp-signal-"));
    try {
      const content = "```typescript\n// Fix for output.ts\nconsole.log('hi')\n```";
      const result = await executeHardPrompt(
        {
          execute: async () => ({
            ok: true,
            value: {
              agentId: "a",
              content,
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
              model: "stub",
              format: "hard-prompt",
            },
          }),
        } as any,
        { description: "write python script" },
        "hp-signal",
        cwd,
        pythonProfile,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const fileSignal = result.value.signals.find((s) => s.kind === "files.written");
        expect(fileSignal).toBeDefined();
        const files = (fileSignal as any).value.files;
        const paths = files.map((f: any) => f.path);
        expect(paths).toContain("solution.py");
      }
      expect(existsSync(join(cwd, "solution.py"))).toBe(true);
      expect(existsSync(join(cwd, "output.ts"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("verification emitter routing", () => {
  it("uses Python verifiers for Python task profiles", () => {
    const emitters = createVerificationEmitters("/tmp", new EventBus(), ["solution.ts"], "python");
    expect(emitters.lint.constructor.name).toBe("LintEngine");
    expect(emitters.types.constructor.name).toBe("PyrightEmitter");
    expect(emitters.security).toBe(emitters.lint);
  });

  it("falls back to Python verifiers for Python-only artifact extensions", () => {
    const emitters = createVerificationEmitters("/tmp", new EventBus(), ["solution.py"]);
    expect(emitters.lint.constructor.name).toBe("LintEngine");
  });

  it("keeps the TypeScript verifier stack for JS/TS artifacts", () => {
    const emitters = createVerificationEmitters("/tmp", new EventBus(), ["src/index.ts"]);
    expect(emitters.lint.constructor.name).toBe("LintEngine");
    expect(emitters.types.constructor.name).toBe("TscEmitter");
    expect(emitters.security).toBe(emitters.lint);
  });
});

describe("decideCorrection", () => {
  const okPacket = {
    taskId: "t1",
    turn: 0,
    ts: "now",
    changes: { filesChanged: 1, paths: ["a.ts"], insertions: 5, deletions: 0 },
    graph: { edgeCount: 3, newEdges: 0, brokenEdges: 0, cycles: 0 },
    verification: {
      lint: { errors: 0, warnings: 0 },
      types: { errors: 0 },
      security: { findings: 0, critical: 0, high: 0 },
      overall: "pass" as const,
    },
    contributingSignals: [],
  };
  it("accepts clean", () =>
    expect(decideCorrection(okPacket, 0, 3, 100, 100, 0).action).toBe("accept"));
  it("escalates critical security (no policy, backward compat)", () =>
    expect(
      decideCorrection(
        {
          ...okPacket,
          verification: {
            ...okPacket.verification,
            security: { findings: 1, critical: 1, high: 0 },
          },
        },
        0,
        3,
        100,
        100,
        0,
      ).action,
    ).toBe("escalate"));
  it("escalates critical security (security required)", () => {
    const packet = {
      ...okPacket,
      verification: { ...okPacket.verification, security: { findings: 1, critical: 1, high: 0 } },
      verifierPolicy: {
        required: ["lint", "types", "security"],
        advisory: [] as string[],
        missingRequired: [] as string[],
        skippedRequired: [] as string[],
      },
    };
    expect(decideCorrection(packet, 0, 3, 100, 100, 0).action).toBe("escalate");
  });
  it("corrects critical security instead of escalating (security advisory)", () => {
    const packet = {
      ...okPacket,
      verification: {
        ...okPacket.verification,
        security: { findings: 2, critical: 1, high: 0 },
        overall: "fail" as const,
      },
      verifierPolicy: {
        required: ["lint", "types"],
        advisory: ["security"],
        missingRequired: [] as string[],
        skippedRequired: [] as string[],
      },
    };
    const d = decideCorrection(packet, 0, 3, 100, 100, 0);
    expect(d.action).toBe("correct");
    expect(d.correctionPrompt).toBeTruthy();
  });
  it("corrects critical security instead of escalating (security absent from policy)", () => {
    const packet = {
      ...okPacket,
      verification: {
        ...okPacket.verification,
        security: { findings: 2, critical: 1, high: 0 },
        overall: "fail" as const,
      },
      verifierPolicy: {
        required: ["lint", "types"],
        advisory: ["graph"],
        missingRequired: [] as string[],
        skippedRequired: [] as string[],
      },
    };
    const d = decideCorrection(packet, 0, 3, 100, 100, 0);
    expect(d.action).toBe("correct");
    expect(d.correctionPrompt).toBeTruthy();
  });
  it("escalates broken edges (no policy)", () =>
    expect(
      decideCorrection(
        { ...okPacket, graph: { ...okPacket.graph, brokenEdges: 1 } },
        0,
        3,
        100,
        100,
        0,
      ).action,
    ).toBe("escalate"));
  it("escalates broken edges (graph required)", () => {
    const packet = {
      ...okPacket,
      graph: { ...okPacket.graph, brokenEdges: 2 },
      verifierPolicy: {
        required: ["lint", "types", "security", "graph"],
        advisory: [] as string[],
        missingRequired: [] as string[],
        skippedRequired: [] as string[],
      },
    };
    expect(decideCorrection(packet, 0, 3, 100, 100, 0).action).toBe("escalate");
  });
  it("corrects broken edges (graph advisory) instead of escalating", () => {
    const packet = {
      ...okPacket,
      graph: { ...okPacket.graph, brokenEdges: 3 },
      verification: { ...okPacket.verification, overall: "warn" as const },
      verifierPolicy: {
        required: ["lint", "types", "security"],
        advisory: ["graph"],
        missingRequired: [] as string[],
        skippedRequired: [] as string[],
      },
    };
    const d = decideCorrection(packet, 0, 3, 100, 100, 0);
    expect(d.action).toBe("correct");
    expect(d.correctionPrompt).toBeTruthy();
  });
  it("does not escalate broken edges when graph absent from policy", () => {
    const packet = {
      ...okPacket,
      graph: { ...okPacket.graph, brokenEdges: 4 },
      verification: { ...okPacket.verification, overall: "warn" as const },
      verifierPolicy: {
        required: ["lint", "types"],
        advisory: [] as string[],
        missingRequired: [] as string[],
        skippedRequired: [] as string[],
      },
    };
    const d = decideCorrection(packet, 0, 3, 100, 100, 0);
    expect(d.action).toBe("correct");
  });
  it("corrects lint errors", () => {
    const d = decideCorrection(
      {
        ...okPacket,
        verification: {
          ...okPacket.verification,
          lint: { errors: 2, warnings: 0 },
          overall: "fail" as const,
        },
      },
      0,
      3,
      100,
      100,
      0,
    );
    expect(d.action).toBe("correct");
    expect(d.correctionPrompt).toBeTruthy();
  });
  it("escalates max corrections", () =>
    expect(
      decideCorrection(
        {
          ...okPacket,
          verification: {
            ...okPacket.verification,
            lint: { errors: 1, warnings: 0 },
            overall: "fail" as const,
          },
        },
        3,
        3,
        100,
        100,
        0,
      ).action,
    ).toBe("escalate"));

  it("taskPass=true accepts even with other conditions", () => {
    expect(decideCorrection(okPacket, 0, 3, 100, 100, 0, undefined, undefined, true).action).toBe(
      "accept",
    );
  });
  it("taskPass=false corrects when verifier passes and corrections remain", () => {
    const result = decideCorrection(okPacket, 0, 3, 100, 100, 0, undefined, undefined, false);
    expect(result.action).toBe("correct");
    expect(result.rationale).toContain("external validator failed");
  });
  it("taskPass=false escalates when corrections exhausted", () => {
    const result = decideCorrection(okPacket, 3, 3, 100, 100, 0, undefined, undefined, false);
    expect(result.action).toBe("escalate");
    expect(result.rationale).toContain("external validator failed");
  });
  it("taskPass=false escalates when cost exceeded", () => {
    const result = decideCorrection(okPacket, 0, 3, 100, 100, 10, 5, undefined, false);
    expect(result.action).toBe("escalate");
    expect(result.rationale).toContain("external validator failed");
  });
  it("taskPass=false never accepts regardless of verifier pass", () => {
    const result = decideCorrection(okPacket, 0, 3, 100, 100, 0, undefined, undefined, false);
    expect(result.action).not.toBe("accept");
  });
  it("taskPass=undefined falls through to verifier logic (no validator)", () => {
    expect(
      decideCorrection(okPacket, 0, 3, 100, 100, 0, undefined, undefined, undefined).action,
    ).toBe("accept");
  });
});

describe("artifact path and extension enforcement", () => {
  const pythonProfile = detectTaskProfile("write a python script");

  it("blocks python task emitting .ts file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-ext-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: output.ts\nconsole.log('hi')\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("forbidden extension .ts");
      expect(existsSync(join(cwd, "output.ts"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks no-dot filenames like Dockerfile under profile that does not allow empty extension", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-nodot-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: Dockerfile\nFROM ubuntu\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("no-extension files not allowed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows no-dot filenames like Dockerfile when no profile is set", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-nodot-noprof-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: Dockerfile\nFROM ubuntu\n### END");
      const results = writeArtifacts(artifacts, cwd);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(results[0].filePath).toBe("Dockerfile");
      expect(readFileSync(join(cwd, "Dockerfile"), "utf-8")).toBe("FROM ubuntu\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not give Makefile a fake extension", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-makefile-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: Makefile\nall:\n\techo hi\n### END");
      const results = writeArtifacts(artifacts, cwd);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(readFileSync(join(cwd, "Makefile"), "utf-8")).toBe("all:\n\techo hi\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks ../escape.py path escape", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-escape-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: ../escape.py\nprint('nope')\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("path escapes sandbox");
      expect(existsSync(join(cwd, "..", "escape.py"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks absolute path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-abs-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: /etc/passwd\nroot:x:0:0\n### END");
      const results = writeArtifacts(artifacts, cwd);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("path escapes sandbox");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks sibling-prefix path escape", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-sibling-"));
    try {
      const siblingPath = cwd + "-evil" + "/file.py";
      const { artifacts } = parseArtifacts(`### FILE: ${siblingPath}\nprint('nope')\n### END`);
      const results = writeArtifacts(artifacts, cwd);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("path escapes sandbox");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows valid .py file for python profile", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-valid-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: solution.py\nprint('hello')\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(readFileSync(join(cwd, "solution.py"), "utf-8")).toBe("print('hello')\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks .d.ts extension via python forbidden list (extracts .ts from last dot)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-dts-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: types.d.ts\ndeclare module 'x'\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("forbidden extension .ts");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks hidden dotfile .env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-dotenv-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: .env\nSECRET=123\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("hidden dotfile");
      expect(results[0].blocked).toContain(".env");
      expect(existsSync(join(cwd, ".env"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks hidden dotfile . gitignore", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-gitignore-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: .gitignore\nnode_modules\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("hidden dotfile");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks .npmrc dotfile", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-npmrc-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: .npmrc\nregistry=evil\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("hidden dotfile");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks long unknown extension that bypasses allowed list", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-longext-"));
    try {
      const { artifacts } = parseArtifacts(
        "### FILE: payload.notallowedbutlong\nprint('nope')\n### END",
      );
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("unexpected extension");
      expect(existsSync(join(cwd, "payload.notallowedbutlong"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("allows valid .py file for Python profile (still works after hardening)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-py-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: solution.py\nprint('hello')\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(true);
      expect(readFileSync(join(cwd, "solution.py"), "utf-8")).toBe("print('hello')\n");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks .env even without a profile", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-dotenv-noprof-"));
    try {
      const { artifacts } = parseArtifacts("### FILE: .env\nSECRET=123\n### END");
      const results = writeArtifacts(artifacts, cwd);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("hidden dotfile");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks symlink escape when parent dir is a symlink pointing outside cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "kirkforge-artifact-symlink-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "kirkforge-artifact-outside-"));
    try {
      mkdirSync(join(cwd, "src"), { recursive: true });
      symlinkSync(outsideDir, join(cwd, "src", "escape"));
      const { artifacts } = parseArtifacts("### FILE: src/escape/pwned.py\nprint('nope')\n### END");
      const results = writeArtifacts(artifacts, cwd, pythonProfile);
      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].blocked).toContain("symlink escape detected");
      expect(existsSync(join(outsideDir, "pwned.py"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

function makePassPacket(taskId: string) {
  return {
    taskId,
    turn: 0,
    ts: new Date().toISOString(),
    verification: {
      lint: { errors: 0, warnings: 0 },
      types: { errors: 0 },
      security: { findings: 0, critical: 0, high: 0 },
      overall: "pass" as const,
    },
    changes: { filesChanged: 1, paths: ["solution.py"], insertions: 5, deletions: 0 },
    graph: { edgeCount: 0, newEdges: 0, brokenEdges: 0, cycles: 0 },
    contributingSignals: [],
  };
}

class TestableOrchestrator extends Orchestrator {
  private _stubDelegate: ((task: TaskInput) => Promise<any>) | null = null;
  constructor(config: OrchestratorConfig) {
    super(config);
  }
  stubDelegate(fn: (task: TaskInput) => Promise<any>) {
    this._stubDelegate = fn;
  }
  override async delegate(task: TaskInput) {
    if (this._stubDelegate) return this._stubDelegate(task);
    return super.delegate(task);
  }
}

describe("correction loop memory metadata", () => {
  it("stores actual model name instead of 'session'", { timeout: 30000 }, async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const modelConfig = {
      providers: {
        "test-provider": {
          provider: "ollama" as const,
          baseUrl: "http://localhost",
          defaultModel: "test-model-xyz",
        },
      },
      defaultProvider: "test-provider",
    };
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async (task: TaskInput) => {
      const packet = makePassPacket(task.taskId ?? "test");
      return ok({
        decision: { mode: "artifact" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('hi')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model-xyz",
          format: "artifact" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: task.taskId ?? "test",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    await orchestrator.runCorrectionLoop(
      { taskId: "mem-model", description: "write a python script" },
      { maxCorrections: 0 },
    );

    const observations = await adapter.query({ kind: "task-observation" });
    expect(observations.ok).toBe(true);
    const obs = observations.value[0];
    expect(obs).toBeDefined();
    expect(obs!.properties.model).toBe("test-model-xyz");
  });

  it("stores nonzero durationMs", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const modelConfig = {
      providers: {
        "test-provider": {
          provider: "ollama" as const,
          baseUrl: "http://localhost",
          defaultModel: "test-model",
        },
      },
      defaultProvider: "test-provider",
    };
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async (task: TaskInput) => {
      const packet = makePassPacket(task.taskId ?? "test");
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('ok')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: task.taskId ?? "test",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    await orchestrator.runCorrectionLoop(
      { taskId: "mem-duration", description: "fix broken-python script" },
      { maxCorrections: 0 },
    );

    const observations = await adapter.query({ kind: "task-observation" });
    expect(observations.ok).toBe(true);
    const obs = observations.value[0];
    expect(obs).toBeDefined();
    expect(typeof obs!.properties.durationMs).toBe("number");
    expect(obs!.properties.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("stores actual mode from emission format, not guessed from verifierOverall", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const modelConfig = {
      providers: {
        "test-provider": {
          provider: "ollama" as const,
          baseUrl: "http://localhost",
          defaultModel: "test-model",
        },
      },
      defaultProvider: "test-provider",
    };
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async (task: TaskInput) => {
      const packet = makePassPacket(task.taskId ?? "test");
      return ok({
        decision: { mode: "artifact" },
        emission: {
          agentId: "a1",
          content: "### FILE: solution.py\nprint('ok')\n### END",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "artifact" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: task.taskId ?? "test",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    await orchestrator.runCorrectionLoop(
      { taskId: "mem-mode", description: "write a python script" },
      { maxCorrections: 0 },
    );

    const observations = await adapter.query({ kind: "task-observation" });
    expect(observations.ok).toBe(true);
    const obs = observations.value[0];
    expect(obs).toBeDefined();
    expect(obs!.properties.mode).toBe("artifact");
  });

  it("taskPass=false with verifier pass records unknown", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const modelConfig = {
      providers: {
        "test-provider": {
          provider: "ollama" as const,
          baseUrl: "http://localhost",
          defaultModel: "test-model",
        },
      },
      defaultProvider: "test-provider",
    };
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    let delegateCallCount = 0;
    orchestrator.stubDelegate(async (task: TaskInput) => {
      delegateCallCount++;
      if (delegateCallCount === 1) {
        const packet = makePassPacket(task.taskId ?? "test");
        return ok({
          decision: { mode: "artifact" },
          emission: {
            agentId: "a1",
            content: "### FILE: solution.py\nprint('ok')\n### END",
            promptTokens: 10,
            completionTokens: 20,
            totalTokens: 30,
            model: "test-model",
            format: "artifact" as const,
          },
          signals: [
            {
              id: "s1",
              taskId: task.taskId ?? "test",
              domain: "files",
              kind: "files.written",
              source: "agent",
              ts: new Date().toISOString(),
              value: { files: ["solution.py"] },
            },
          ],
          packet,
        });
      }
      const packet = makePassPacket(task.taskId ?? "test");
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('fixed')\n```",
          promptTokens: 5,
          completionTokens: 10,
          totalTokens: 15,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [],
        packet,
      });
    });

    const result = await orchestrator.runCorrectionLoop(
      { taskId: "mem-taskpass", description: "write a python script", taskPass: false },
      { maxCorrections: 1 },
    );

    expect(result.finalAction).toBe("escalate");

    const observations = await adapter.query({ kind: "task-observation" });
    expect(observations.ok).toBe(true);
    const obs = observations.value[0];
    expect(obs).toBeDefined();
    expect(obs!.properties.outcome).toBe("fail");
    expect(obs!.properties.taskPass).toBe(false);
    expect(obs!.properties.finalVerdict).toBe("unknown");
  });
});

describe("validator integration: real shell commands", () => {
  // Shell-based validator tests can be slow due to child process spawning
  vi.setConfig({ testTimeout: 30000 });
  const prevAllowUnsafe = process.env.ALLOW_UNSAFE_VALIDATOR_SHELL;
  beforeAll(() => {
    process.env.ALLOW_UNSAFE_VALIDATOR_SHELL = "1";
  });
  afterAll(() => {
    if (prevAllowUnsafe === undefined) delete process.env.ALLOW_UNSAFE_VALIDATOR_SHELL;
    else process.env.ALLOW_UNSAFE_VALIDATOR_SHELL = prevAllowUnsafe;
  });
  const modelConfig = {
    providers: {
      "test-provider": {
        provider: "ollama" as const,
        baseUrl: "http://localhost",
        defaultModel: "test-model",
      },
    },
    defaultProvider: "test-provider",
  };

  it("validator exit 0 -> finalVerdict pass, sourceOfTruth task-validator, taskPass true", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async () => {
      const packet = makePassPacket("v-pass");
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('ok')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: "v-pass",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    const result = await orchestrator.runCorrectionLoop(
      { taskId: "v-pass", description: "write a python script" },
      { maxCorrections: 0, validator: { shellCommand: "true", timeoutMs: 5000 } },
    );

    expect(result.finalVerdict).toBe("pass");
    expect(result.sourceOfTruth).toBe("task-validator");
    expect(result.taskValidation.status).toBe("pass");
    expect(result.taskValidation.validator).toBe("true");
    expect(result.taskOutcome).toBe("pass");
  });

  it("validator exit 1 -> finalVerdict fail, taskPass false, no accept", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async () => {
      const packet = makePassPacket("v-fail");
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('ok')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: "v-fail",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    const result = await orchestrator.runCorrectionLoop(
      { taskId: "v-fail", description: "write a python script" },
      { maxCorrections: 0, validator: { shellCommand: "false", timeoutMs: 5000 } },
    );

    expect(result.finalVerdict).toBe("fail");
    expect(result.sourceOfTruth).toBe("task-validator");
    expect(result.taskValidation.status).toBe("fail");
    expect(result.taskValidation.validator).toBe("false");
    expect(result.taskOutcome).toBe("fail");
    expect(result.finalAction).toBe("escalate");
  });

  it("validator timeout -> finalVerdict unknown, taskPass null", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async () => {
      const packet = makePassPacket("v-timeout");
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('ok')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: "v-timeout",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    const result = await orchestrator.runCorrectionLoop(
      { taskId: "v-timeout", description: "write a python script" },
      { maxCorrections: 0, validator: { shellCommand: "sleep 30", timeoutMs: 500 } },
    );

    expect(result.finalVerdict).toBe("unknown");
    expect(result.sourceOfTruth).toBe("task-validator");
    expect(result.taskValidation.status).toBe("error");
    expect(result.taskOutcome).toBe("unknown");
    expect(result.finalAction).toBe("escalate");
  }, 15000);

  it("validator pass with verifier fail still uses task-validator as sourceOfTruth", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    let _callCount = 0;
    orchestrator.stubDelegate(async () => {
      _callCount++;
      const packet = {
        taskId: "v-src",
        turn: 0,
        ts: new Date().toISOString(),
        verification: {
          lint: { errors: 1, warnings: 0 },
          types: { errors: 1 },
          security: { findings: 0, critical: 0, high: 0 },
          overall: "fail" as const,
        },
        changes: { filesChanged: 1, paths: ["solution.py"], insertions: 5, deletions: 0 },
        graph: { edgeCount: 0, newEdges: 0, brokenEdges: 0, cycles: 0 },
        contributingSignals: [],
      };
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('ok')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: "v-src",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    const result = await orchestrator.runCorrectionLoop(
      { taskId: "v-src", description: "write a python script" },
      { maxCorrections: 0, validator: { shellCommand: "true", timeoutMs: 5000 } },
    );

    expect(result.finalVerdict).toBe("pass");
    expect(result.sourceOfTruth).toBe("task-validator");
    expect(result.taskValidation.status).toBe("pass");
  });

  it("validator result is JSON-serializable (CLI compatibility)", async () => {
    const adapter = new InMemoryAdapter();
    const store = new MemoryStore(adapter);
    const orchestrator = new TestableOrchestrator({ modelConfig, memoryStore: store });

    orchestrator.stubDelegate(async () => {
      const packet = makePassPacket("v-json");
      return ok({
        decision: { mode: "hard-prompt" },
        emission: {
          agentId: "a1",
          content: "```python\nprint('ok')\n```",
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          model: "test-model",
          format: "hard-prompt" as const,
        },
        signals: [
          {
            id: "s1",
            taskId: "v-json",
            domain: "files",
            kind: "files.written",
            source: "agent",
            ts: new Date().toISOString(),
            value: { files: ["solution.py"] },
          },
        ],
        packet,
      });
    });

    const result = await orchestrator.runCorrectionLoop(
      { taskId: "v-json", description: "write a python script" },
      {
        maxCorrections: 0,
        validator: { shellCommand: "echo 'all tests passed'", timeoutMs: 5000 },
      },
    );

    const json = JSON.stringify({
      finalAction: result.finalAction,
      finalVerdict: result.finalVerdict,
      sourceOfTruth: result.sourceOfTruth,
      taskValidation: result.taskValidation,
      taskOutcome: result.taskOutcome,
    });
    const parsed = JSON.parse(json);
    expect(parsed.finalVerdict).toBe("pass");
    expect(parsed.sourceOfTruth).toBe("task-validator");
    expect(parsed.taskValidation.status).toBe("pass");
    expect(parsed.taskOutcome).toBe("pass");
  });
});
