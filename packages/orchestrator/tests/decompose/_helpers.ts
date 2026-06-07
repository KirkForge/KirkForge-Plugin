import type { TaskNode, EstimatedComplexity } from "@kirkforge/core-types";

// ── Helpers to exercise _parseDecomposition and _topologicalSort ──────────
// These are private methods on Orchestrator. The MockOrchestrator below
// re-implements the logic inline for testability (the canonical copy lives
// on the production class). Step 8 of the godfile-refactor plan will
// extract the production methods to a real module and replace this mock
// with the real implementation.

export interface ParseResult {
  ok: boolean;
  value?: {
    rootTask: string;
    tasks: TaskNode[];
    totalEstimatedTokens: number;
    rationale: string;
  };
  error?: Error;
}

export interface MockOrchestrator {
  _parseDecomposition(raw: string): ParseResult;
  _topologicalSort(nodes: TaskNode[]): { ok: boolean; value?: TaskNode[]; error?: Error };
}

export function makeOrchestrator(): MockOrchestrator {
  // Lightweight partial mock — we only need the private parser methods
  class _MockOrchestrator {
    _parseDecomposition(raw: string): ParseResult {
      // Re-implement the logic inline for testability
      let jsonStr = raw.trim();
      const codeBlock = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
      if (codeBlock) jsonStr = codeBlock[1]!.trim();
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
          return { ok: false, error: new Error("Decomposition output must be a JSON array") };
        tasks = parsed;
      } catch (e) {
        return {
          ok: false,
          error: new Error("Failed to parse decomposition JSON: " + (e as Error).message),
        };
      }

      if (tasks.length === 0)
        return { ok: false, error: new Error("Decomposition produced zero subtasks") };

      const validComplexities = new Set(["trivial", "simple", "moderate", "complex"]);
      const nodes: TaskNode[] = [];
      const ids = new Set<string>();

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i] as Record<string, unknown>;
        const id = String(t.id ?? `task-${i + 1}`);
        if (ids.has(id)) return { ok: false, error: new Error(`Duplicate task id: ${id}`) };
        ids.add(id);

        const complexity = String(t.estimatedComplexity ?? "moderate");
        if (!validComplexities.has(complexity))
          return {
            ok: false,
            error: new Error(`Invalid complexity "${complexity}" in task ${id}`),
          };

        nodes.push({
          id,
          description: String(t.description ?? "").slice(0, 500),
          language: String(t.language ?? "text"),
          dependsOn: Array.isArray(t.dependsOn) ? (t.dependsOn as unknown[]).map(String) : [],
          estimatedComplexity: complexity as EstimatedComplexity,
          outputFiles: Array.isArray(t.outputFiles)
            ? (t.outputFiles as unknown[]).map(String).slice(0, 20)
            : [],
          verificationHint: String(t.verificationHint ?? "").slice(0, 200),
        });
      }

      for (const node of nodes) {
        if (node.dependsOn.includes(node.id))
          return { ok: false, error: new Error(`Task ${node.id} cannot depend on itself`) };
        for (const dep of node.dependsOn) {
          if (!ids.has(dep))
            return {
              ok: false,
              error: new Error(`Task ${node.id} depends on unknown task: ${dep}`),
            };
        }
      }

      if (nodes.length > 24)
        return {
          ok: false,
          error: new Error(`Decomposition produced ${nodes.length} subtasks; maximum is 24`),
        };
      const sorted = this._topologicalSort(nodes);
      if ("error" in sorted && !sorted.ok) return { ok: false, error: sorted.error };

      const s = (sorted as { ok: true; value: TaskNode[] }).value;
      const tokenEstimate = s.length * 400 + s.reduce((sum, n) => sum + n.description.length, 0);

      return {
        ok: true,
        value: {
          rootTask: "",
          tasks: s,
          totalEstimatedTokens: tokenEstimate,
          rationale: `Decomposed into ${s.length} subtasks (${s.filter((n) => n.dependsOn.length > 0).length} with dependencies)`,
        },
      };
    }

    _topologicalSort(nodes: TaskNode[]): { ok: boolean; value?: TaskNode[]; error?: Error } {
      const byId = new Map<string, TaskNode>();
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

      const sorted: TaskNode[] = [];
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
        return { ok: false, error: new Error("Cycle detected in task dependencies") };
      return { ok: true, value: sorted };
    }
  }
  return new _MockOrchestrator();
}
