# Key Rotation

This document describes how to rotate cryptographic keys in 55NDeep for
enterprise deployments. Key rotation limits the blast radius of key compromise
and is required by SOC 2 (CC6.1), ISO 27001 (A.10.1.2), and PCI DSS (3.6).

## Key Types

| Key                     | Purpose                           | Rotation Impact                                      | Storage                   |
| ----------------------- | --------------------------------- | ---------------------------------------------------- | ------------------------- |
| JWT signing key (OIDC)  | Token verification                | Active tokens invalid until JWKS refresh             | IdP-managed               |
| Policy signing HMAC key | Signed policy bundle verification | All policies must be re-signed                       | `55NDEEP_POLICY_HMAC_KEY` |
| Tenant KEK (master)     | Per-tenant DEK derivation         | All tenant data must be re-encrypted                 | Vault / KMS               |
| API key                 | Static bearer authentication      | Active sessions invalidated                          | `55NDEEP_API_KEY`         |
| Audit chain hash seed   | Audit log integrity               | New chain starts; old chain verifiable independently | `WORM_AUDIT_SEED`         |

## Rotation Procedures

### 1. JWT Signing Key (OIDC)

JWT signing keys are managed by the upstream identity provider (e.g., Keycloak,
Okta, Auth0). 55NDeep consumes the JWKS endpoint and caches keys for the
duration configured in `OidcConfig.jwksUri`.

**To rotate:**

1. Add a new signing key in the IdP. The IdP publishes both keys in JWKS.
2. 55NDeep automatically picks up the new key on next JWKS cache refresh (30s cooldown).
3. Old tokens signed with the previous key remain valid until expiry.
4. After all old tokens have expired, remove the old key from the IdP.

**No downtime or configuration change is needed in 55NDeep.**

### 2. Policy Signing HMAC Key

Policy bundles are signed with `signPolicyHmac()` and verified with
`verifySignedPolicy()`.

**To rotate:**

1. Generate a new HMAC key: `openssl rand -hex 32`
2. Set `55NDEEP_POLICY_HMAC_KEY` to the new key in your deployment environment.
3. Re-sign all policy bundles with the new key:
   ```bash
   55ndeep policy sign --key "$NEW_HMAC_KEY" policy.json
   ```
4. Deploy the new key and re-signed policies simultaneously.
5. During the transition window, maintain both old and new keys in the
   verification chain by setting `55NDEEP_POLICY_HMAC_KEY_PREVIOUS` to the old key.
   The policy engine will verify against both keys.

### 3. Tenant Key Encryption Key (KEK)

The master KEK is used to derive per-tenant Data Encryption Keys (DEKs) via
`TenantKeyProvider`. See `core-secrets/src/index.ts` for the implementation.

**To rotate:**

1. Generate a new master KEK: `openssl rand -hex 32`
2. Initialize a new `TenantKeyProvider` with the new master key.
3. For each tenant:
   a. Decrypt all existing data using the old key provider.
   b. Re-encrypt with the new key provider (`encryptForTenant()`).
   c. Store the re-encrypted data.
4. Update the master KEK in Vault/KMS.
5. Clear the old key provider cache.

**Key versioning**: `TenantKeyProvider` supports versioned keys. When you call
`rotateKey(tenantId)`, a new DEK version is derived and the previous version
remains active for decryption. Set `activeKeyVersions` (default: 2) to control
how many old versions are kept.

**For zero-downtime rotation:**

- Run the re-encryption as a background job.
- The old provider remains active for reads until re-encryption completes.
- Switch reads to the new provider atomically once re-encryption finishes.

### 4. API Key

**To rotate:**

1. Generate a new API key: `openssl rand -hex 32`
2. Update `55NDEEP_API_KEY` (or `HEALTH_API_KEY`) in the deployment environment.
3. Restart the 55NDeep process. Active sessions using the old key are immediately
   invalidated.

**For zero-downtime rotation:**

- Support a `55NDEEP_API_KEY_PREVIOUS` env var that allows the old key to remain
  valid for a grace period (e.g., 1 hour).
- Remove the previous key after the grace period.

### 5. Audit Chain Hash Seed

The WORM audit sink uses a seed hash for chain integrity verification.

**To rotate:**

1. Rotate the seed by calling `WormAuditSink` with a new `seedHash` parameter.
2. The new seed creates a new chain segment. Previous segments remain
   independently verifiable using their original seed.
3. `verifyIntegrity()` validates each segment independently.

## Key Storage Best Practices

| Key         | Production Storage               | Development Storage  |
| ----------- | -------------------------------- | -------------------- |
| JWT signing | IdP-managed                      | Local JWKS (testing) |
| Policy HMAC | HashiCorp Vault                  | Environment variable |
| Tenant KEK  | AWS KMS / GCP KMS / Vault        | Random 32-byte key   |
| API key     | Vault / KMS                      | Environment variable |
| Audit seed  | Vault (immutable after creation) | Random seed          |

## Emergency Key Compromise Response

If a key is suspected compromised:

1. **Immediately** rotate the affected key using the procedures above.
2. **Within 1 hour**: Notify all tenant admins via the audit log and SIEM integration.
3. **Within 24 hours**: Re-encrypt all data that was encrypted with the compromised key.
4. **Within 48 hours**: Complete a post-incident review and update the key rotation schedule.
5. **Document** the incident in the audit log with the `policy.change` action.

## Key Rotation Schedule

| Key         | Minimum Rotation Frequency | Recommended                  |
| ----------- | -------------------------- | ---------------------------- |
| JWT signing | Per IdP policy             | 90 days                      |
| Policy HMAC | 90 days                    | 30 days                      |
| Tenant KEK  | 365 days                   | 90 days                      |
| API key     | 90 days                    | On compromise or team change |
| Audit seed  | Never (immutable)          | N/A                          |

## Related

- `core-secrets/src/index.ts` — `TenantKeyProvider`, `SecretsManager`
- `core-rbac/src/jwt-verify.ts` — JWKS key rotation handling
- `core-policy/src/index.ts` — `signPolicyHmac()`, `verifySignedPolicy()`
- `core-events/src/audit.ts` — `WormAuditSink`, chain hash integrity

## Per-Tenant Encryption at Rest (New in v8)

### Architecture

Per-tenant encryption is now wired into the data flow via `TenantEncryptionAdapter`
(`core-tenancy/src/tenant-encryption.ts`). When enabled, each tenant's memory
store data (descriptions, properties, tags) is encrypted with a unique DEK
derived from the master KEK using HMAC-SHA256.

**Data flow:**

```
Application
  → TenantRegistry.createMemoryStore(tenantId, { keyProvider })
    → TenantEncryptionAdapter(innerAdapter, keyProvider, tenantId)
      → write: TenantKeyProvider.encryptForTenant(tenantId, plaintext)
        → HMAC-SHA256 KEK derivation → AES-256-GCM encryption
          → Inner adapter stores: v{version}:{iv}:{tag}:{ciphertext}
      → read: TenantKeyProvider.decryptForTenant(tenantId, ciphertext)
        → Version-prefixed decryption with active DEK versions
```

### Enabling Per-Tenant Encryption

Set the `55NDEEP_TENANT_KEK` environment variable with a 32-byte hex-encoded
master key (64 hex characters). This must be set **before** starting the daemon
in enterprise mode.

```bash
# Generate a master KEK
openssl rand -hex 32

# Set in environment
export 55NDEEP_TENANT_KEK=<64-hex-char-key>

# Start daemon
55ndeep serve
```

In enterprise mode, the bootstrap will:

1. Load the master KEK from `55NDEEP_TENANT_KEK` via the secrets chain.
2. Initialize a `TenantKeyProvider` with the master key.
3. Wire `TenantEncryptionAdapter` into each tenant's `MemoryStore`.

If the key is missing or invalid, the daemon logs a warning and proceeds with
unencrypted storage. **Production deployments must set this key.**

### Key Rotation for Per-Tenant Encryption

The `TenantKeyProvider` supports online key rotation without re-encryption:

```typescript
const keyProvider = new TenantKeyProvider({ masterKey: Buffer.from(kekHex, "hex") });

// Rotate a tenant's DEK — new writes use v2, old data remains readable with v1
keyProvider.rotateKey("tenant-abc123");

// New writes are encrypted with v2
const ciphertext = keyProvider.encryptForTenant("tenant-abc123", "sensitive data");

// Old v1 data is still decryptable (activeKeyVersions = 2 by default)
keyProvider.decryptForTenant("tenant-abc123", "v1:...:...:...");
```

**Master KEK rotation** (full re-encryption):

1. Generate a new master KEK: `openssl rand -hex 32`
2. Initialize both old and new `TenantKeyProvider` instances.
3. For each tenant, decrypt all data with the old provider and re-encrypt
   with the new provider.
4. Update `55NDEEP_TENANT_KEK` in the deployment environment.
5. Restart the daemon.

### Ciphertext Format

Per-tenant encrypted data uses the versioned format from `TenantKeyProvider`:

```
v{version}:{iv_base64}:{tag_base64}:{ciphertext_base64}
```

- `version`: Monotonically increasing integer, incremented on `rotateKey()`.
- `iv`: 12-byte IV for AES-256-GCM (base64).
- `tag`: 16-byte authentication tag (base64).
- `ciphertext`: AES-256-GCM encrypted payload (base64).

Legacy unencrypted data is handled gracefully: if decryption fails (no version
prefix), the adapter returns the raw object, enabling smooth migration from
unencrypted to encrypted storage.

### Related

- `core-tenancy/src/tenant-encryption.ts` — `TenantEncryptionAdapter`
- `core-secrets/src/index.ts` — `TenantKeyProvider`, `encryptForTenant`, `decryptForTenant`
- `core-tenancy/src/index.ts` — `TenantRegistry.createMemoryStore({ keyProvider })`
- `apps/cli/src/bootstrap.ts` — Per-tenant encryption wiring in enterprise mode
