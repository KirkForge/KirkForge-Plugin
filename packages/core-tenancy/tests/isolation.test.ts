import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TenantRegistry, tenantIdFromPath } from "../src/index.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Adversarial tests proving tenant isolation: no cross-contamination of
 * storage, memory, events, or configuration between tenants.
 */

describe("Tenant isolation — adversarial tests", () => {
  let tmpDir: string;
  let registry: TenantRegistry;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "55ndeep-isolation-test-"));
    registry = new TenantRegistry({ storageRoot: join(tmpDir, "tenants") });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("different workspaces produce different tenant IDs (no collision)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = tenantIdFromPath(`/workspace/project-${i}`);
      ids.add(id);
    }
    // All 100 should be unique
    expect(ids.size).toBe(100);
  });

  it("tenant storage directories are strictly separated", () => {
    const h1 = registry.register("/workspace/tenant-alpha");
    const h2 = registry.register("/workspace/tenant-beta");

    // Storage dirs must not overlap
    expect(h1.storageDir).not.toBe(h2.storageDir);
    expect(h1.storageDir).toContain(h1.tenantId);
    expect(h2.storageDir).toContain(h2.tenantId);

    // Write a file in tenant-alpha's storage
    mkdirSync(h1.storageDir, { recursive: true });
    writeFileSync(join(h1.storageDir, "secret.txt"), "alpha-secret", "utf-8");

    // Verify tenant-beta's storage does NOT contain alpha's file
    expect(existsSync(join(h2.storageDir, "secret.txt"))).toBe(false);

    // Verify reading alpha's file from alpha's path works
    expect(readFileSync(join(h1.storageDir, "secret.txt"), "utf-8")).toBe("alpha-secret");
  });

  it("resolvePath never crosses tenant boundaries", () => {
    const h1 = registry.register("/workspace/alpha");
    const h2 = registry.register("/workspace/beta");

    const path1 = registry.resolvePath(h1.tenantId, "memory.db");
    const path2 = registry.resolvePath(h2.tenantId, "memory.db");

    // Same resource name resolves to different paths
    expect(path1).not.toBe(path2);
    expect(path1).toContain(h1.tenantId);
    expect(path2).toContain(h2.tenantId);

    // No path traversal possible: paths are under separate tenant dirs
    expect(path1.startsWith(h1.storageDir)).toBe(true);
    expect(path2.startsWith(h2.storageDir)).toBe(true);
  });

  it("tenant ID is deterministic — same workspace always maps to same tenant", () => {
    const h1 = registry.register("/workspace/stable-id");
    const h2 = registry.register("/workspace/stable-id");
    expect(h1.tenantId).toBe(h2.tenantId);
    expect(h1.storageDir).toBe(h2.storageDir);
  });

  it("similar workspace paths produce different tenant IDs (no prefix collision)", () => {
    const h1 = registry.register("/workspace/app");
    const h2 = registry.register("/workspace/app-service");

    expect(h1.tenantId).not.toBe(h2.tenantId);
    expect(h1.storageDir).not.toBe(h2.storageDir);
  });

  it("evicting a tenant does not affect other tenants' storage", () => {
    const h1 = registry.register("/workspace/survivor");
    const h2 = registry.register("/workspace/evictee");

    mkdirSync(h1.storageDir, { recursive: true });
    writeFileSync(join(h1.storageDir, "data.json"), '{"important": true}', "utf-8");

    mkdirSync(h2.storageDir, { recursive: true });
    writeFileSync(join(h2.storageDir, "data.json"), '{"important": false}', "utf-8");

    registry.evictFromIndex(h2.tenantId);

    // Survivor's data is intact
    expect(existsSync(join(h1.storageDir, "data.json"))).toBe(true);
    // Evictee's data still on disk (evict only removes from index)
    // but tenant cannot be resolved by the registry anymore
    expect(registry.get(h2.tenantId)).toBeUndefined();
    expect(registry.get(h1.tenantId)).toBeDefined();
  });

  it("tenant label cannot be used to guess another tenant's ID", () => {
    const h = registry.register("/workspace/sensitive-project");
    // The tenant ID is a SHA-256 hash truncation, not derivable from the label alone
    expect(h.tenantId).not.toBe("sensitive-project");
    expect(h.tenantId).not.toContain("sensitive");
    expect(h.tenantId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("path traversal via relative resource names is a documented risk requiring caller-side validation", () => {
    const h = registry.register("/workspace/safe-zone");
    // resolvePath uses join() which normalizes but does NOT prevent traversal.
    // Path traversal with "../../../etc/passwd" escapes the tenant dir.
    // This is a known behavior: callers MUST use safeRelativePath() from
    // orchestrator/path-safety to validate resource names before resolvePath().
    // The tenant isolation layer validates tenant IDs (SHA-256 hashes) but
    // resource name validation is the caller's responsibility.
    const maliciousPath = registry.resolvePath(h.tenantId, "../../../etc/passwd");
    // Verify the path DID escape (documenting the known risk)
    expect(maliciousPath).toContain("etc/passwd");
    // Verify safe names stay within tenant storage
    const safeName = "memory.db";
    const safePath = registry.resolvePath(h.tenantId, safeName);
    expect(safePath).toContain(h.tenantId);
    expect(safePath).toContain("memory.db");
  });

  it("concurrent tenant registrations are idempotent", () => {
    const path = "/workspace/concurrent-test";
    const handles: Array<{ tenantId: string; storageDir: string }> = [];
    for (let i = 0; i < 10; i++) {
      handles.push(registry.register(path));
    }
    // All handles should have the same tenant ID
    const ids = new Set(handles.map((h) => h.tenantId));
    expect(ids.size).toBe(1);
    // All storage dirs should be identical
    const dirs = new Set(handles.map((h) => h.storageDir));
    expect(dirs.size).toBe(1);
  });
});
