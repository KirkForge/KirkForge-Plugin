#!/usr/bin/env node
/**
 * 55NDeep MCP Server — exposes verification, correction, and routing tools
 * via Model Context Protocol (stdio transport).
 *
 * Compatible with Claude Desktop, Codex CLI, Copilot, and any MCP host.
 *
 * Usage:
 *   npx @55ndeep/mcp
 *   node apps/mcp/dist/index.js
 *
 * Tools exposed:
 *   - 55ndeep_verify_workspace: Run deterministic verification
 *   - 55ndeep_doctor: Check tool availability
 *   - 55ndeep_record_observation: Record task outcome for routing memory
 *   - 55ndeep_recall_routing_bias: Recall routing recommendation
 *   - 55ndeep_build_correction_prompt: Generate correction prompt from a packet
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  verifyWorkspace,
  doctor,
  buildCorrectionPrompt,
  recordObservation,
  recallRoutingBias,
} from "@55ndeep/plugin";
import { MemoryStore } from "@55ndeep/memory-palace";

// ── Shared MemoryStore ─────────────────────────────────────────────────────

const memoryStore = new MemoryStore({ backend: "memory" });

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "55ndeep_verify_workspace",
    description: "Run deterministic verification on a workspace. Returns a ReducedStatePacket with lint, type, security, change, and graph analysis results.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Absolute path to the workspace directory" },
        files: { type: "array", items: { type: "string" }, description: "Specific files to verify (optional)" },
        language: { type: "string", enum: ["typescript", "javascript", "python", "shell", "cpp", "c", "rust", "go", "sql", "text"], description: "Task language" },
        description: { type: "string", description: "Task description for language profile detection" },
        taskId: { type: "string", description: "Task identifier (optional, auto-generated)" },
      },
      required: ["workspace"],
    },
  },
  {
    name: "55ndeep_doctor",
    description: "Check availability of all verification tools (eslint, tsc, ruff, pyright, bandit, git) and return a capability report.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "55ndeep_record_observation",
    description: "Record a task outcome into the routing memory for future recall.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Unique task identifier" },
        description: { type: "string", description: "Task description" },
        language: { type: "string", description: "Programming language" },
        mode: { type: "string", description: "Delegation mode used" },
        model: { type: "string", description: "Model used for the task" },
        outcome: { type: "string", enum: ["pass", "fail", "escalate", "error"], description: "Task outcome" },
        durationMs: { type: "number", description: "Task duration in milliseconds" },
        tokens: { type: "number", description: "Total tokens consumed (optional)" },
        verifierOverall: { type: "string", description: "Overall verifier result (optional)" },
      },
      required: ["taskId", "description", "language", "mode", "model", "outcome", "durationMs"],
    },
  },
  {
    name: "55ndeep_recall_routing_bias",
    description: "Recall routing recommendation for a task description based on past observations.",
    inputSchema: {
      type: "object",
      properties: {
        taskDescription: { type: "string", description: "Task description to match" },
        workerModel: { type: "string", description: "Current worker model (optional)" },
      },
      required: ["taskDescription"],
    },
  },
  {
    name: "55ndeep_build_correction_prompt",
    description: "Generate a correction prompt from a ReducedStatePacket for the worker model to fix issues.",
    inputSchema: {
      type: "object",
      properties: {
        packet: { type: "object", description: "ReducedStatePacket from verifyWorkspace" },
        language: { type: "string", description: "Task language for tool name mapping" },
        maxTokens: { type: "number", description: "Maximum tokens for the correction prompt (optional)" },
      },
      required: ["packet"],
    },
  },
];

// ── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "55ndeep-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "55ndeep_verify_workspace": {
        const result = await verifyWorkspace({
          workspace: args?.workspace as string,
          files: args?.files as string[] | undefined,
          language: args?.language as string | undefined,
          description: args?.description as string | undefined,
          taskId: args?.taskId as string | undefined,
        });
        if (!result.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error.message }) }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };
      }

      case "55ndeep_doctor": {
        const report = await doctor();
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      }

      case "55ndeep_record_observation": {
        const result = await recordObservation({
          taskId: args?.taskId as string,
          description: args?.description as string,
          language: args?.language as string,
          mode: args?.mode as string,
          model: args?.model as string,
          outcome: args?.outcome as "pass" | "fail" | "escalate" | "error",
          durationMs: args?.durationMs as number,
          tokens: args?.tokens as number | undefined,
          verifierOverall: args?.verifierOverall as string | undefined,
        }, memoryStore);
        if (!result.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error.message }) }], isError: true };
        }
        return { content: [{ type: "text", text: "Observation recorded successfully" }] };
      }

      case "55ndeep_recall_routing_bias": {
        const result = await recallRoutingBias(
          args?.taskDescription as string,
          args?.workerModel as string | undefined,
          memoryStore,
        );
        if (!result.ok) {
          return { content: [{ type: "text", text: JSON.stringify({ error: result.error.message }) }], isError: true };
        }
        return { content: [{ type: "text", text: JSON.stringify(result.value, null, 2) }] };
      }

      case "55ndeep_build_correction_prompt": {
        const prompt = buildCorrectionPrompt(args?.packet as any, {
          language: args?.language as string | undefined,
          maxTokens: args?.maxTokens as number | undefined,
        });
        return { content: [{ type: "text", text: prompt }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e) {
    return {
      content: [{ type: "text", text: `Tool error: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so it doesn't interfere with MCP stdio protocol
  process.stderr.write("55NDeep MCP server running on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`MCP server fatal: ${e.message}\n`);
  process.exit(1);
});
