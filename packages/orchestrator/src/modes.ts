import type { Agent } from "@55ndeep/agent-core";
import type { TaskBrief } from "@55ndeep/prompt-core";
import type { DelegationResult } from "./types.js";
import type { OrchestratorResult } from "./types.js";
import { ok, err } from "@55ndeep/core-types";
import {
  renameSync,
  writeFileSync as writeFileSyncRaw,
  mkdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, relative, dirname } from "node:path";
import { extensionForLanguage, type TaskProfile } from "./task-profile.js";
import {
  disallowedArtifact,
  segmentsHaveEscapingSymlink,
  finalFileIsSymlink,
} from "./artifact-mode.js";
import type { ParsedArtifact } from "./artifact-mode.js";
import { sha256Of, isBinaryLikeContent, isInsideCwd, MAX_ARTIFACT_BYTES } from "./path-safety.js";

// ── Hard-prompt code-block persistence ─────────────────────────────────────

/**
 * Extracts fenced code blocks from raw model output and persists them
 * into `cwd` using the same safety primitives as artifact-mode.
 */
function persistCodeBlocks(
  content: string,
  cwd: string,
  profile?: TaskProfile,
): {
  written: string[];
  blocked: Array<{ path: string; reason: string }>;
  hashes: string[];
  fileBytes: number[];
  beforeHashes: (string | null)[];
  existed: boolean[];
} {
  const written: string[] = [];
  const blocked: Array<{ path: string; reason: string }> = [];
  const beforeHashSnapshots = new Map<string, { beforeHash: string | null; existed: boolean }>();
  const blocks = [...content.matchAll(/```([A-Za-z0-9_+#.-]*)\s*\n([\s\S]*?)```/g)];
  if (blocks.length === 0) {
    blocks.push(...content.matchAll(/```\s*\n([\s\S]*?)```/g));
  }
  const ext = extensionForLanguage(profile?.language);
  const baseName = profile?.defaultFile ?? `output${ext}`;

  for (let i = 0; i < blocks.length; i++) {
    const match = blocks[i]!;
    const code = (match[2] ?? match[1] ?? "").trim();
    const name = blocks.length === 1 ? baseName : baseName.replace(/\.(\w+)$/, `-${i + 1}.$1`);
    const fp = resolve(cwd, name);

    if (!isInsideCwd(fp, cwd)) {
      blocked.push({ path: name, reason: `path escapes sandbox: ${name}` });
      continue;
    }

    const artifact: ParsedArtifact = { filePath: name, content: code + "\n" };
    const rejection = disallowedArtifact(artifact, profile);
    if (rejection) {
      blocked.push({ path: name, reason: rejection });
      continue;
    }

    if (segmentsHaveEscapingSymlink(fp, cwd)) {
      blocked.push({ path: name, reason: `symlink escape detected: ${name}` });
      continue;
    }

    if (finalFileIsSymlink(fp)) {
      blocked.push({
        path: name,
        reason: `final path is symlink — writes would follow link outside sandbox: ${name}`,
      });
      continue;
    }

    if (Buffer.byteLength(code + "\n", "utf-8") > MAX_ARTIFACT_BYTES) {
      blocked.push({
        path: name,
        reason: `artifact exceeds ${MAX_ARTIFACT_BYTES} byte limit: ${name}`,
      });
      continue;
    }

    if (isBinaryLikeContent(code)) {
      blocked.push({ path: name, reason: `binary-like content detected: ${name}` });
      continue;
    }

    // Enforce write policy — overwrite requires explicit opt-in
    const existed = existsSync(fp);
    if (existed && profile?.writePolicy?.allowOverwrite !== true) {
      blocked.push({
        path: name,
        reason: `overwrite denied (allowOverwrite not enabled in writePolicy): ${name}`,
      });
      continue;
    }
    if (profile?.writePolicy?.denyPaths) {
      const relPath = relative(cwd, fp);
      if (profile.writePolicy.denyPaths.some((d) => relPath === d || relPath.startsWith(d + "/"))) {
        blocked.push({ path: name, reason: `path denied by writePolicy: ${name}` });
        continue;
      }
    }

    try {
      mkdirSync(dirname(fp), { recursive: true });
      // Snapshot beforeHash BEFORE the atomic write
      beforeHashSnapshots.set(
        name,
        (() => {
          try {
            const prevContent = readFileSync(fp, "utf-8");
            return { beforeHash: sha256Of(prevContent), existed: true };
          } catch {
            return { beforeHash: null, existed: false };
          }
        })(),
      );
      const tmpPath = fp + ".tmp." + Date.now() + "." + randomBytes(4).toString("hex");
      writeFileSyncRaw(tmpPath, code + "\n", "utf-8");
      renameSync(tmpPath, fp);
      written.push(name);
    } catch {
      blocked.push({ path: name, reason: `write error: ${name}` });
    }
  }
  const hashes: string[] = [];
  const fileBytes: number[] = [];
  const beforeHashes: (string | null)[] = [];
  const existed: boolean[] = [];
  for (const name of written) {
    const fullPath = resolve(cwd, name);
    const snapshot = beforeHashSnapshots.get(name);
    try {
      const fileContent = readFileSync(fullPath, "utf-8");
      hashes.push(sha256Of(fileContent));
      fileBytes.push(Buffer.byteLength(fileContent, "utf-8"));
    } catch {
      hashes.push("");
      fileBytes.push(0);
    }
    beforeHashes.push(snapshot?.beforeHash ?? null);
    existed.push(snapshot?.existed ?? false);
  }
  return { written, blocked, hashes, fileBytes, beforeHashes, existed };
}

// ── Mode executors ─────────────────────────────────────────────────────────

export async function executeHardPrompt(
  agent: Agent,
  brief: TaskBrief,
  taskId: string,
  cwd: string = process.cwd(),
  profile?: TaskProfile,
): Promise<OrchestratorResult> {
  const result = await agent.execute(brief);
  if (!result.ok) return err(result.error);
  const emission = result.value;

  const wasTruncated = emission.finishReason === "length" || emission.finishReason === "max_tokens";
  const { written, blocked, hashes, fileBytes, beforeHashes, existed } = wasTruncated
    ? { written: [], blocked: [], hashes: [], fileBytes: [], beforeHashes: [], existed: [] }
    : persistCodeBlocks(emission.content, cwd, profile);
  const truncationWarning = wasTruncated
    ? `model output was truncated (finish_reason: ${emission.finishReason}) — file content may be incomplete`
    : undefined;

  const signals: DelegationResult["signals"] = [
    {
      id: `sig-${taskId}`,
      taskId,
      domain: "task",
      kind: "emission",
      source: emission.agentId,
      ts: new Date().toISOString(),
      value: { content: emission.content.slice(0, 200) },
    },
    {
      id: `sig-files-${taskId}`,
      taskId,
      domain: "code",
      kind: "files.written",
      source: emission.agentId,
      ts: new Date().toISOString(),
      value: {
        files: written.map((w, i) => ({
          path: w,
          sha256: hashes[i] ?? "",
          bytes: fileBytes[i] ?? 0,
          beforeHash: beforeHashes[i] ?? null,
          existed: existed[i] ?? false,
        })),
        language: profile?.language ?? "unknown",
      },
    },
  ];
  if (blocked.length > 0) {
    signals.push({
      id: `sig-blocked-${taskId}`,
      taskId,
      domain: "code",
      kind: "artifact.blocked",
      source: emission.agentId,
      ts: new Date().toISOString(),
      value: { blockedPaths: blocked.map((b) => ({ path: b.path, reason: b.reason })) },
    });
  }
  if (truncationWarning) {
    signals.push({
      id: `sig-truncated-${taskId}`,
      taskId,
      domain: "code",
      kind: "artifact.truncated",
      source: emission.agentId,
      ts: new Date().toISOString(),
      value: { finishReason: emission.finishReason, warnings: [truncationWarning] },
    });
  }

  const dr: DelegationResult = {
    decision: {
      mode: "hard-prompt",
      reason: `hard-prompt delegation: ${written.length} files written${blocked.length > 0 ? `, ${blocked.length} blocked` : ""}`,
      autoRouted: true,
    },
    emission,
    signals,
  };
  return ok(dr);
}

export async function executeSchemaContract(
  agent: Agent,
  brief: TaskBrief,
  taskId: string,
): Promise<OrchestratorResult> {
  const result = await agent.execute(brief);
  if (!result.ok) return err(result.error);
  const emission = result.value;
  if (!emission.schemaContract)
    return err(
      new Error("Schema-Contract delegation failed: no valid schema extraction after retry"),
    );
  const wasTruncated = emission.finishReason === "length" || emission.finishReason === "max_tokens";
  const truncationWarning = wasTruncated
    ? `model output was truncated (finish_reason: ${emission.finishReason}) — schema contract output may be incomplete`
    : undefined;
  const dr: DelegationResult = {
    decision: { mode: "schema-contract", reason: "structured verification", autoRouted: true },
    emission,
    signals: [
      {
        id: `sig-${taskId}`,
        taskId,
        domain: "task",
        kind: "emission",
        source: emission.agentId,
        ts: new Date().toISOString(),
        value: { content: emission.content.slice(0, 200) },
      },
      {
        id: `sig-ts-${taskId}`,
        taskId,
        domain: "quality",
        kind: "schema.validated",
        source: emission.agentId,
        ts: new Date().toISOString(),
        value: { validated: true },
        confidence: wasTruncated ? 0.4 : 0.95,
      },
    ],
  };
  if (wasTruncated) {
    dr.signals.push({
      id: `sig-truncated-${taskId}`,
      taskId,
      domain: "code",
      kind: "artifact.truncated",
      source: emission.agentId,
      ts: new Date().toISOString(),
      value: { finishReason: emission.finishReason, warnings: [truncationWarning!] },
    });
  }
  return ok(dr);
}
