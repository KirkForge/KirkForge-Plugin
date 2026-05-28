/**
 * Per-tenant encryption adapter for MemoryStore.
 *
 * Uses TenantKeyProvider from core-secrets to derive per-tenant Data Encryption
 * Keys (DEKs) from a master Key Encryption Key (KEK). Each tenant's data is
 * encrypted with a unique DEK derived via HMAC-SHA256, supporting key rotation
 * with versioned ciphertext.
 *
 * Wire this into TenantRegistry.createMemoryStore() to enable per-tenant
 * encryption at rest. In enterprise mode, this is required — tenant data must
 * never be stored in plaintext.
 */

import type { MemoryAdapter, MemoryObject, MemoryQuery, MemoryStats } from "@55ndeep/memory-palace";
import { ok, err, type Result } from "@55ndeep/core-types";
import type { TenantKeyProvider } from "@55ndeep/core-secrets";

// ── Tenant-scoped encryption adapter ────────────────────────────────────────

/**
 * Wraps any MemoryAdapter and encrypts/decrypts MemoryObject payloads using
 * per-tenant Data Encryption Keys (DEKs) derived from a master KEK.
 *
 * On write: encrypts `description` and `properties` with the tenant's current
 * DEK version. The ciphertext format is `v{version}:{iv}:{tag}:{data}` (base64),
 * matching TenantKeyProvider.encryptForTenant().
 *
 * On read: decrypts using the appropriate key version, allowing transparent
 * key rotation — data written with an old DEK version is decrypted with that
 * version's key, while new writes use the latest version.
 *
 * If decryption fails (e.g., legacy unencrypted data or wrong tenant), the
 * adapter returns the raw object, allowing graceful migration.
 */
export class TenantEncryptionAdapter implements MemoryAdapter {
  constructor(
    private inner: MemoryAdapter,
    private keyProvider: TenantKeyProvider,
    private tenantId: string,
  ) {}

  async write(obj: MemoryObject): Promise<Result<void, Error>> {
    try {
      const encrypted: MemoryObject = {
        ...obj,
        description: this.keyProvider.encryptForTenant(this.tenantId, obj.description),
        properties: JSON.parse(
          this.keyProvider.encryptForTenant(this.tenantId, JSON.stringify(obj.properties)),
        ),
        tags: obj.tags.map((tag) => this.keyProvider.encryptForTenant(this.tenantId, tag)),
      };
      return this.inner.write(encrypted);
    } catch (cause) {
      return err(
        new Error(
          `TenantEncryptionAdapter: encryption failed for tenant ${this.tenantId}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      );
    }
  }

  async read(id: string): Promise<Result<MemoryObject | null, Error>> {
    const result = await this.inner.read(id);
    if (!result.ok || !result.value) return result;

    try {
      return ok(this.decryptObject(result.value));
    } catch {
      // If decryption fails, return the raw object (might be unencrypted legacy data)
      return result;
    }
  }

  async query(q: MemoryQuery): Promise<Result<MemoryObject[], Error>> {
    const result = await this.inner.query(q);
    if (!result.ok) return result;

    const decrypted = result.value.map((obj) => {
      try {
        return this.decryptObject(obj);
      } catch {
        return obj; // Legacy unencrypted data
      }
    });

    return ok(decrypted);
  }

  async stats(): Promise<Result<MemoryStats, Error>> {
    return this.inner.stats();
  }

  writeRun?(run: Parameters<NonNullable<MemoryAdapter["writeRun"]>>[0]): void {
    this.inner.writeRun?.(run);
  }

  writeEmission?(emission: Parameters<NonNullable<MemoryAdapter["writeEmission"]>>[0]): void {
    this.inner.writeEmission?.(emission);
  }

  queryRuns?(limit?: number): Array<Record<string, unknown>> {
    return this.inner.queryRuns?.(limit) ?? [];
  }

  queryEmissionsForRun?(runId: string): Array<Record<string, unknown>> {
    return this.inner.queryEmissionsForRun?.(runId) ?? [];
  }

  writeRunAndEmissions?(
    run: Parameters<NonNullable<MemoryAdapter["writeRunAndEmissions"]>>[0],
    emissions: Parameters<NonNullable<MemoryAdapter["writeRunAndEmissions"]>>[1],
  ): void {
    this.inner.writeRunAndEmissions?.(run, emissions);
  }

  schemaVersion?(): number | null {
    return this.inner.schemaVersion?.() ?? null;
  }

  async persist(): Promise<void> {
    return this.inner.persist();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private decryptObject(obj: MemoryObject): MemoryObject {
    return {
      ...obj,
      description: this.keyProvider.decryptForTenant(this.tenantId, obj.description),
      properties: JSON.parse(
        this.keyProvider.decryptForTenant(this.tenantId, JSON.stringify(obj.properties)),
      ),
      tags: obj.tags.map((tag) => this.keyProvider.decryptForTenant(this.tenantId, tag)),
    };
  }
}
