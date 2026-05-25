#!/usr/bin/env node

import { Command } from "commander";
import { createBootstrap } from "./bootstrap.js";
import {
  doctor,
  buildCorrectionPrompt,
  recordObservation,
  recallRoutingBias,
  verifyWorkspace,
} from "@55ndeep/plugin";
import { ReducedStatePacketSchema } from "@55ndeep/core-schemas";
import { FileAdapter, MemoryStore } from "@55ndeep/memory-palace";
import { TenantRegistry } from "@55ndeep/core-tenancy";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { URL } from "node:url";
import { startDaemon } from "./serve.js";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const ALL_MODES = ["hard-prompt", "schema-contract", "artifact"];

function exitError(message: string, json?: boolean): never {
  if (json) {
    process.stdout.write(JSON.stringify({ error: message }) + "\n");
  } else {
    process.stderr.write(`Error: ${message}\n`);
  }
  process.exit(1);
}

const program = new Command();
program.name("55ndeep").description("Deterministic LLM output verification CLI").version(VERSION);

program
  .command("delegate")
  .description("Delegate a task to the orchestrator with automatic mode routing")
  .argument("<description>", "Task description")
  .option("--mode <mode>", `Delegation mode: ${ALL_MODES.join(", ")}`)
  .option("--provider <key>", "Provider key from config (e.g. openai, local-ollama)")
  .option("--context <text>", "Additional context for the task")
  .option("--file <paths...>", "Target files for the task")
  .option("--json", "JSON output")
  .action(async (description, opts) => {
    if (opts.mode && !ALL_MODES.includes(opts.mode)) {
      exitError(`--mode must be one of: ${ALL_MODES.join(", ")}`, opts.json);
    }
    const {
      orchestrator,
      shutdown: _shutdown,
      policyEngine: _policyEngine,
      auditLogger: _auditLogger,
    } = await createBootstrap(opts);
    const result = await orchestrator.delegate({
      description,
      modeOverride: opts.mode,
      context: opts.context,
      files: opts.file,
    });

    if (opts.json) {
      if (result.ok) {
        console.log(
          JSON.stringify(
            {
              mode: result.value.decision.mode,
              content: result.value.emission.content,
              tokens: result.value.emission.totalTokens,
              model: result.value.emission.model,
              packet: result.value.packet ?? null,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(JSON.stringify({ error: result.error.message }, null, 2));
        process.exit(1);
      }
    } else {
      if (result.ok) {
        console.log(
          `\n[Mode: ${result.value.decision.mode}] [${result.value.emission.model}] [${result.value.emission.totalTokens} tokens]`,
        );
        console.log(result.value.emission.content);
        if (result.value.packet) {
          const p = result.value.packet;
          console.log(`\n--- Verification ---`);
          console.log(
            `  Lint:  ${p.verification.lint.errors} errors, ${p.verification.lint.warnings} warnings`,
          );
          console.log(`  Types: ${p.verification.types.errors} errors`);
          console.log(
            `  Security: ${p.verification.security.findings} findings (${p.verification.security.critical} critical)`,
          );
          console.log(`  Changes: ${p.changes.filesChanged} files`);
          console.log(`  Verdict: ${p.verification.overall}`);
        }
      } else {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
    }
  });

program
  .command("run")
  .description("Run a task with the correction loop (accept/correct/escalate)")
  .argument("<description>", "Task description")
  .option("--mode <mode>", `Delegation mode: ${ALL_MODES.join(", ")}`)
  .option("--provider <key>", "Provider key from config")
  .option("--max-corrections <n>", "Maximum correction attempts", "2")
  .option("--max-cost <n>", "Maximum cost budget in USD")
  .option("--context <text>", "Additional context for the task")
  .option("--file <paths...>", "Target files for the task")
  .option(
    "--validator <command>",
    "Structured validator: command name (no shell expansion, args passed separately)",
  )
  .option("--validator-args <args...>", "Arguments for structured --validator")
  .option(
    "--validator-shell <command>",
    "Raw shell validator command (unsafe: host must sandbox); exit 0 means pass",
  )
  .option("--validator-timeout-ms <n>", "Validator timeout in milliseconds", "120000")
  .option("--max-tokens <n>", "Maximum output tokens for model generation")
  .option("--temperature <n>", "Model sampling temperature (0.0-2.0)")
  .option("--json", "JSON output")
  .action(async (description, opts) => {
    if (opts.mode && !ALL_MODES.includes(opts.mode)) {
      exitError(`--mode must be one of: ${ALL_MODES.join(", ")}`, opts.json);
    }
    const maxCorrections = parseInt(opts.maxCorrections ?? "2", 10);
    const maxCost = opts.maxCost ? parseFloat(opts.maxCost) : undefined;
    const validatorTimeoutMs = parseInt(opts.validatorTimeoutMs ?? "120000", 10);

    if (Number.isNaN(maxCorrections) || maxCorrections < 0 || !Number.isInteger(maxCorrections)) {
      exitError("--max-corrections must be a non-negative integer", opts.json);
    }
    if (
      opts.maxCost !== undefined &&
      maxCost !== undefined &&
      (Number.isNaN(maxCost) || maxCost < 0)
    ) {
      exitError("--max-cost must be a non-negative number", opts.json);
    }
    if (opts.validator && (Number.isNaN(validatorTimeoutMs) || validatorTimeoutMs <= 0)) {
      exitError("--validator-timeout-ms must be a positive integer", opts.json);
    }

    // Raw shell validator is gated behind ALLOW_UNSAFE_SHELL_VALIDATOR — enterprise policy
    if (opts.validatorShell && process.env.ALLOW_UNSAFE_SHELL_VALIDATOR !== "true") {
      exitError(
        "--validator-shell requires ALLOW_UNSAFE_SHELL_VALIDATOR=true (unsafe: host must sandbox)",
        opts.json,
      );
    }

    const validatorConfig = opts.validatorShell
      ? { shellCommand: opts.validatorShell, timeoutMs: validatorTimeoutMs }
      : opts.validator
        ? { command: opts.validator, args: opts.validatorArgs ?? [], timeoutMs: validatorTimeoutMs }
        : undefined;

    const {
      orchestrator,
      shutdown: _shutdown,
      policyEngine: _policyEngine,
      auditLogger: _auditLogger,
    } = await createBootstrap(opts);

    const outcome = await orchestrator.runCorrectionLoop(
      { description, modeOverride: opts.mode, context: opts.context, files: opts.file },
      { maxCorrections, maxCost, validator: validatorConfig },
    );

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            finalAction: outcome.finalAction,
            finalVerdict: outcome.finalVerdict,
            sourceOfTruth: outcome.sourceOfTruth,
            taskValidation: outcome.taskValidation,
            taskOutcome: outcome.taskOutcome,
            taskPass:
              outcome.taskValidation.status === "pass"
                ? true
                : outcome.taskValidation.status === "fail"
                  ? false
                  : null,
            turns: outcome.turns.map((t, i) => ({
              turn: i + 1,
              action: t.action,
              rationale: t.rationale,
              workerTokens: t.workerTokens,
              sessionTokens: t.sessionTokens,
              verification: t.packet.verification.overall,
              lint: t.packet.verification.lint,
              types: t.packet.verification.types,
              security: t.packet.verification.security,
            })),
            sessionTokens: outcome.sessionTokens,
            sessionCost: outcome.sessionCost,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\nCorrection Loop — ${outcome.turns.length} turns`);
      for (let i = 0; i < outcome.turns.length; i++) {
        const t = outcome.turns[i]!;
        console.log(
          `  Turn ${i + 1}: ${t.action} — ${t.rationale} [${t.workerTokens} tokens, ${t.packet.verification.overall}]`,
        );
      }
      console.log(`\nFinal action: ${outcome.finalAction}`);
      console.log(`Final verdict: ${outcome.finalVerdict} (${outcome.sourceOfTruth})`);
      if (outcome.sourceOfTruth === "task-validator") {
        console.log(
          `Task validator: ${outcome.taskValidation.status} — ${outcome.taskValidation.reason ?? outcome.taskValidation.validator}`,
        );
      }
      console.log(`Session tokens: ${outcome.sessionTokens}`);
      console.log(`Session cost: $${outcome.sessionCost.toFixed(4)}`);
    }
  });

program

  .command("decompose")
  .description("Break a complex task into smaller, independently verifiable subtasks")
  .argument("<description>", "Task description to decompose")
  .option("--provider <key>", "Provider key from config (e.g. openai, local-ollama)")
  .option("--json", "JSON output")
  .option("--execute", "Execute the decomposed subtasks in dependency order")
  .action(async (description, opts) => {
    const {
      orchestrator,
      shutdown: _shutdown,
      policyEngine: _policyEngine,
      auditLogger: _auditLogger,
    } = await createBootstrap(opts);
    const result = await orchestrator.decomposeTask({ description });

    if (opts.json) {
      if (result.ok) {
        console.log(JSON.stringify(result.value, null, 2));
      } else {
        console.log(JSON.stringify({ error: result.error.message }, null, 2));
        process.exit(1);
      }
    } else {
      if (result.ok) {
        const d = result.value;
        console.log(`\nDecomposed "${d.rootTask}" into ${d.tasks.length} subtasks:`);
        console.log(`Rationale: ${d.rationale}`);
        console.log(`Estimated tokens: ~${d.totalEstimatedTokens}\n`);
        for (const t of d.tasks) {
          const deps = t.dependsOn.length > 0 ? ` (needs: ${t.dependsOn.join(", ")})` : "";
          console.log(`  [${t.id}] ${t.estimatedComplexity} | ${t.language}${deps}`);
          console.log(`    ${t.description}`);
          if (t.outputFiles.length > 0) console.log(`    → ${t.outputFiles.join(", ")}`);
          if (t.verificationHint) console.log(`    ✓ ${t.verificationHint}`);
        }
      } else {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
    }

    if (opts.execute) {
      const taskId = "decomp-" + description.slice(0, 40).replace(/[^a-zA-Z0-9]/g, "-");
      console.log("\nExecuting decomposition...\n");
      const execResult = await orchestrator.executeDecomposition(taskId);
      if (execResult.ok) {
        const er = execResult.value;
        if (opts.json) {
          console.log(JSON.stringify(er, null, 2));
        } else {
          console.log(
            "Execution complete: " +
              er.succeededCount +
              "/" +
              er.totalSubtasks +
              " subtasks succeeded",
          );
          console.log(
            "Total tokens: " +
              er.totalTokens +
              " | Duration: " +
              (er.totalDurationMs / 1000).toFixed(1) +
              "s\n",
          );
          for (const r of er.results) {
            const status = r.ok ? "✓" : "✗";
            console.log(
              "  " +
                status +
                " [" +
                r.nodeId +
                "] " +
                r.description.slice(0, 60) +
                " (" +
                (r.durationMs / 1000).toFixed(1) +
                "s, " +
                r.tokensUsed +
                " tokens)",
            );
            if (r.error) console.log("      Error: " + r.error);
            if (r.files && r.files.length > 0) console.log("      Files: " + r.files.join(", "));
          }
        }
      } else {
        console.error("Execution failed: " + execResult.error.message);
        process.exit(1);
      }
    }
  });

program
  .command("verify")
  .description("Run deterministic verification emitters without calling a model")
  .option("--task <description>", "Task description used only for verifier language routing")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const {
      orchestrator,
      shutdown: _shutdown,
      policyEngine: _policyEngine,
      auditLogger: _auditLogger,
    } = await createBootstrap(opts);
    const packet = await orchestrator.verify({ description: opts.task });

    if (opts.json) {
      console.log(JSON.stringify(packet, null, 2));
    } else {
      console.log(`\n--- Verification Report ---`);
      console.log(`  Lint errors:    ${packet.verification.lint.errors}`);
      console.log(`  Lint warnings:  ${packet.verification.lint.warnings}`);
      if (packet.verification.lint.suppressed) {
        console.log(`  Lint suppressed: ${packet.verification.lint.suppressed}`);
      }
      console.log(`  Type errors:    ${packet.verification.types.errors}`);
      console.log(
        `  Security:       ${packet.verification.security.findings} findings (${packet.verification.security.critical} critical, ${packet.verification.security.high} high)`,
      );
      console.log(`  Files changed:  ${packet.changes.filesChanged}`);
      console.log(
        `  Graph:          ${packet.graph.edgeCount} edges (${packet.graph.brokenEdges} broken, ${packet.graph.cycles} cycles)`,
      );
      console.log(`  Overall:        ${packet.verification.overall.toUpperCase()}`);
    }
  });

program
  .command("doctor")
  .description("Probe local verification tools and report capabilities")
  .option("--pretty", "Human-readable output instead of JSON")
  .action(async (opts) => {
    const report = await doctor();

    if (opts.pretty) {
      console.log("\n--- Tool Capability Report ---");
      const tools: [
        string,
        { available: boolean; version?: string; source?: string; note?: string },
      ][] = [
        ["ESLint", report.eslint],
        ["TypeScript (tsc)", report.tsc],
        ["Ruff", report.ruff],
        ["Pyright", report.pyright],
        ["Bandit", report.bandit],
        ["SecDev", report.secdev],
        ["GitNexus", report.gitnexus],
        ["Graphify", report.graphify],
      ];
      for (const [name, cap] of tools) {
        const src = cap.source === "internal" ? " [internal]" : "";
        const status = cap.available
          ? `available (${cap.version ?? "bundled"})${src}`
          : `not found${src}`;
        const note = cap.note ? ` -- ${cap.note}` : "";
        console.log(`  ${name}: ${status}${note}`);
      }
      console.log(`  Languages: ${report.languages.join(", ")}`);
    } else {
      console.log(JSON.stringify(report));
    }
  });

program
  .command("prompt")
  .description("Build a correction prompt from a verification packet")
  .requiredOption("--packet <path>", "Path to a ReducedStatePacket JSON file")
  .option("--language <lang>", "Task language for tool name resolution")
  .action((opts) => {
    let raw: string;
    try {
      raw = readFileSync(opts.packet, "utf-8");
    } catch {
      console.error(`Error: cannot read file: ${opts.packet}`);
      process.exit(1);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(`Error: invalid JSON in file: ${opts.packet}`);
      process.exit(1);
    }

    if (typeof parsed !== "object" || parsed === null || !parsed) {
      console.error("Error: packet JSON is not an object");
      process.exit(1);
    }

    const result = ReducedStatePacketSchema.safeParse(parsed);
    if (!result.success) {
      console.error("Error: packet shape is not a valid ReducedStatePacket");
      for (const issue of result.error.issues) {
        console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
      }
      process.exit(1);
    }
    const packet = result.data;

    let prompt: string;
    try {
      prompt = buildCorrectionPrompt(packet, { language: opts.language });
    } catch {
      console.error("Error: failed to build correction prompt from packet");
      process.exit(1);
    }

    process.stdout.write(prompt);
    process.stdout.write("\n");
  });

program
  .command("observe")
  .description("Record a task observation to memory")
  .option("--workspace <path>", "Workspace path (enables tenant-scoped memory)")
  .option("--memory <path>", "Path to the memory store file")
  .option("--sqlite", "Use SQLite adapter instead of file-based")
  .requiredOption("--task-id <id>", "Task identifier")
  .requiredOption("--description <text>", "Task description")
  .requiredOption("--language <lang>", "Task language")
  .requiredOption("--mode <mode>", "Delegation mode")
  .requiredOption("--model <model>", "Worker model used")
  .requiredOption("--outcome <result>", "Task outcome: pass, fail, or escalate")
  .requiredOption("--duration-ms <n>", "Duration in milliseconds")
  .option("--tokens <n>", "Token count")
  .action(async (opts) => {
    if (!opts.workspace && !opts.memory) {
      console.error("Error: either --workspace or --memory is required");
      process.exit(1);
    }
    if (!ALL_MODES.includes(opts.mode)) {
      console.error(`Error: --mode must be one of: ${ALL_MODES.join(", ")}`);
      process.exit(1);
    }
    const validOutcomes = ["pass", "fail", "escalate"];
    if (!validOutcomes.includes(opts.outcome)) {
      console.error(`Error: --outcome must be one of: ${validOutcomes.join(", ")}`);
      process.exit(1);
    }

    const durationMs = parseInt(opts.durationMs, 10);
    if (Number.isNaN(durationMs) || durationMs < 0) {
      console.error("Error: --duration-ms must be a non-negative integer");
      process.exit(1);
    }

    const tokens = opts.tokens ? parseInt(opts.tokens, 10) : undefined;
    if (tokens !== undefined && (Number.isNaN(tokens) || tokens < 0)) {
      console.error("Error: --tokens must be a non-negative integer");
      process.exit(1);
    }

    let adapter;
    let memoryPath: string;
    if (opts.workspace) {
      if (!existsSync(resolve(opts.workspace))) {
        exitError(`Workspace directory does not exist: ${opts.workspace}`, opts.json);
      }
      const registry = new TenantRegistry();
      const tenant = registry.register(opts.workspace);
      memoryPath = registry.resolvePath(tenant.tenantId, "memory.db");
    } else {
      memoryPath = opts.memory!;
    }
    if (opts.sqlite) {
      const { SqliteAdapter } = await import("@55ndeep/memory-palace/sqlite-adapter");
      adapter = new SqliteAdapter(memoryPath);
    } else {
      adapter = new FileAdapter(memoryPath);
    }
    const memoryStore = new MemoryStore(adapter);

    const result = await recordObservation(
      {
        taskId: opts.taskId,
        description: opts.description,
        language: opts.language,
        mode: opts.mode,
        model: opts.model,
        outcome: opts.outcome,
        durationMs,
        tokens,
      },
      memoryStore,
    );

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    await adapter.persist();

    console.log(JSON.stringify({ ok: true, taskId: opts.taskId, outcome: opts.outcome }));
  });

program
  .command("recall")
  .description("Recall routing bias from past task observations")
  .option("--workspace <path>", "Workspace path (enables tenant-scoped memory)")
  .option("--memory <path>", "Path to the memory store file")
  .option("--sqlite", "Use SQLite adapter instead of file-based")
  .requiredOption("--description <text>", "Task description to match")
  .option("--model <model>", "Worker model to filter by")
  .action(async (opts) => {
    if (!opts.workspace && !opts.memory) {
      console.error("Error: either --workspace or --memory is required");
      process.exit(1);
    }
    let adapter;
    let memoryPath: string;
    if (opts.workspace) {
      if (!existsSync(resolve(opts.workspace))) {
        exitError(`Workspace directory does not exist: ${opts.workspace}`, opts.json);
      }
      const registry = new TenantRegistry();
      const tenant = registry.register(opts.workspace);
      memoryPath = registry.resolvePath(tenant.tenantId, "memory.db");
    } else {
      memoryPath = opts.memory!;
    }
    if (opts.sqlite) {
      const { SqliteAdapter } = await import("@55ndeep/memory-palace/sqlite-adapter");
      adapter = new SqliteAdapter(memoryPath);
    } else {
      adapter = new FileAdapter(memoryPath);
    }
    const memoryStore = new MemoryStore(adapter);

    const result = await recallRoutingBias(opts.description, opts.model, memoryStore);

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    console.log(JSON.stringify({ ok: true, bias: result.value }));
  });

program
  .command("recall-decomposition")
  .description("Recall a previously stored task decomposition")
  .argument("<task-id-or-description>", "Task ID or description substring to search for")
  .option("--json", "JSON output")
  .action(async (query, opts) => {
    const adapter = new FileAdapter(resolve(process.cwd(), ".55ndeep-memory.json"));
    const memoryStore = new MemoryStore(adapter);
    const result = await memoryStore.recallDecomposition(query);

    if (opts.json) {
      if (result.ok && result.value) {
        console.log(JSON.stringify(result.value, null, 2));
      } else if (result.ok) {
        console.log(JSON.stringify({ found: false, query }, null, 2));
      } else {
        console.log(JSON.stringify({ error: result.error.message }, null, 2));
        process.exit(1);
      }
    } else {
      if (result.ok && result.value) {
        const d = result.value;
        console.log(`\nDecomposition for "${d.description}" (stored ${d.timestamp}):`);
        console.log(`${d.tasks.length} subtasks:\n`);
        for (const t of d.tasks) {
          const deps = t.dependsOn.length > 0 ? ` (needs: ${t.dependsOn.join(", ")})` : "";
          console.log(`  [${t.id}] ${t.estimatedComplexity} | ${t.language}${deps}`);
          console.log(`    ${t.description}`);
          if (t.outputFiles.length > 0) console.log(`    → ${t.outputFiles.join(", ")}`);
          if (t.verificationHint) console.log(`    ✓ ${t.verificationHint}`);
        }
      } else if (result.ok) {
        console.log(`No decomposition found for "${query}"`);
      } else {
        console.error(`Error: ${result.error.message}`);
        process.exit(1);
      }
    }
  });

program
  .command("verify-workspace")
  .description("Run deterministic verification on a workspace and output a ReducedStatePacket")
  .requiredOption("--workspace <path>", "Path to the workspace directory")
  .option("--file <paths...>", "Specific files to verify")
  .option("--language <lang>", "Task language (typescript, javascript, python, etc.)")
  .option("--description <text>", "Task description for language profile detection")
  .option("--task-id <id>", "Task identifier for the verification run")
  .action(async (opts) => {
    const result = await verifyWorkspace({
      workspace: opts.workspace,
      files: opts.file,
      language: opts.language,
      description: opts.description,
      taskId: opts.taskId,
    });

    if (!result.ok) {
      console.error(`Error: ${result.error.message}`);
      process.exit(1);
    }

    console.log(JSON.stringify(result.value));
  });

program
  .command("tools")
  .description("List registered verification tools")
  .action(async () => {
    console.log("55NDeep Native Lint Engines (internal, always available):");
    console.log("  JS/TS:  tool-lint-ts (29 rules)");
    console.log("  Python: tool-lint-py (34 rules)");
    console.log("  Shell:  tool-lint-sh (9 rules)");
    console.log("  C/C++:  tool-lint-c (10 rules)");
    console.log("  Rust:   tool-lint-rs (8 rules)");
    console.log("  Go:     tool-lint-go (7 rules)");
    console.log("  SQL:    tool-lint-sql (6 rules)");
    console.log("");
    console.log("Type Checkers (external, required on PATH):");
    console.log("  JS/TS:  tsc");
    console.log("  Python: pyright");
    console.log("");
    console.log("Shared Tools:");
    console.log("  gitnexus (git diff change tracking)");
    console.log("  graphify (import graph analysis, TS only)");
  });

program
  .command("health")
  .description("Show orchestrator health and SLO status")
  .action(async () => {
    const {
      orchestrator,
      shutdown: _shutdown,
      policyEngine: _policyEngine,
      auditLogger: _auditLogger,
    } = await createBootstrap({});
    const h = orchestrator.healthCheck();
    console.log(`Status:         ${h.status}`);
    console.log(
      `EventBus:       ${h.eventBus.running ? "running" : "stopped"} (inflight: ${h.eventBus.inflight})`,
    );
    console.log(`Memory:         ${h.memory}`);
    console.log(`Providers:      ${h.providers}`);
    console.log(`Delegations:    ${h.stats.totalDelegations}`);
    console.log(`Total tokens:   ${h.stats.totalTokens}`);

    const slo = await orchestrator.slo();
    if (slo) {
      console.log(`\n--- SLO Burn-Rate Report ---`);
      for (const w of slo.windows) {
        const pct = (w.rate * 100).toFixed(1);
        const budgetPct = (w.budgetRemaining * 100).toFixed(1);
        console.log(
          `  ${w.name}: rate=${pct}% budget=${budgetPct}% burn=${w.burnRate.toFixed(2)}x status=${w.status}`,
        );
      }
    } else {
      console.log(`\nSLO:           no prior runs — run tasks to populate SLO windows`);
    }
  });

program
  .command("audit-verify")
  .description("Verify the integrity of an audit log chain (checks sequential hashes)")
  .requiredOption("--file <path>", "Path to audit JSONL file")
  .option("--json", "JSON output")
  .action(async (opts) => {
    const filePath = resolve(opts.file);
    if (!existsSync(filePath)) {
      exitError(`Audit file not found: ${filePath}`, opts.json);
    }

    // Genesis hash matches the one in core-events/audit.ts
    const GENESIS_INPUT = "55ndeep-audit-genesis";
    const genesisHash = createHash("sha256")
      .update(GENESIS_INPUT, "utf-8")
      .digest("hex")
      .slice(0, 24);

    let prevHash: string = genesisHash;
    let lineCount = 0;
    const errors: string[] = [];
    const actions: Record<string, number> = {};
    const actors: Record<string, number> = {};

    const fileStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lineCount++;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(trimmed);
      } catch {
        errors.push(`Line ${lineCount}: Invalid JSON`);
        continue;
      }

      const chainHash = event.chainHash as string | undefined;
      if (!chainHash) {
        errors.push(`Line ${lineCount}: Missing chainHash`);
        continue;
      }

      // Recompute expected hash from previous hash + event fields
      const seq = event.sequence as number | undefined;
      const action = event.action as string | undefined;
      const actorId = event.actorId as string | undefined;
      const tenantId = event.tenantId as string | undefined;
      const timestamp = event.timestamp as string | undefined;

      const payload = `${prevHash}|${action ?? ""}|${actorId ?? ""}|${tenantId ?? ""}|${timestamp ?? ""}|${seq ?? ""}`;
      const expected = createHash("sha256").update(payload, "utf-8").digest("hex").slice(0, 24);

      if (chainHash !== expected) {
        errors.push(
          `Line ${lineCount}: Hash mismatch (expected ${expected}, got ${chainHash}). Chain is broken.`,
        );
        // Stop checking further — chain is broken
        break;
      }

      prevHash = chainHash;

      // Stats
      const a = action ?? "unknown";
      actions[a] = (actions[a] ?? 0) + 1;
      const act = actorId ?? "unknown";
      actors[act] = (actors[act] ?? 0) + 1;
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            valid: errors.length === 0,
            lineCount,
            errors: errors.length > 0 ? errors : undefined,
            actions,
            actors,
          },
          null,
          2,
        ),
      );
    } else {
      if (errors.length === 0) {
        console.log(`✓ Audit chain integrity verified (${lineCount} events)`);
        console.log(`
Event summary:`);
        for (const [action, count] of Object.entries(actions)) {
          console.log(`  ${action}: ${count}`);
        }
        if (Object.keys(actors).length > 0) {
          console.log(`
Actors:`);
          for (const [actor, count] of Object.entries(actors)) {
            console.log(`  ${actor}: ${count}`);
          }
        }
      } else {
        console.error(`✗ Audit chain integrity FAILED`);
        for (const e of errors) {
          console.error(`  ${e}`);
        }
        process.exit(1);
      }
    }
  });

program
  .command("serve")
  .description("Start daemon with health-check HTTP server (blocks until SIGTERM)")
  .action(async () => {
    const {
      orchestrator,
      eventBus,
      shutdown: _shutdown,
      enterpriseConfig,
      policyEngine,
      auditLogger,
      logger,
    } = await createBootstrap({});
    await startDaemon({
      orchestrator,
      eventBus,
      enterpriseConfig,
      policyEngine,
      auditLogger,
      logger,
    });
  });

program.parse();
