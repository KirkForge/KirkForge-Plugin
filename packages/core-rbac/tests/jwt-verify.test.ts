import { describe, it, expect, beforeEach } from "vitest";
import { verifyJwt, validateJwtClaims, clearJwksCache } from "../src/index.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { OidcConfig, GroupRoleMapping } from "../src/index.js";

describe("verifyJwt", () => {
  const audience = "55ndeep";

  let rsaKeyPair: CryptoKeyPair;
  let rsaPublicKeyJwk: Record<string, unknown>;

  beforeEach(async () => {
    clearJwksCache();
    rsaKeyPair = await generateKeyPair("RS256", { extractable: true });
    rsaPublicKeyJwk = await exportJWK(rsaKeyPair.publicKey);
  });

  async function signToken(
    payload: Record<string, unknown>,
    keyPair?: CryptoKeyPair,
  ): Promise<string> {
    const kp = keyPair ?? rsaKeyPair;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
      .sign(kp.privateKey);
  }

  it("accepts a valid JWT with matching issuer and audience using local JWKS", async () => {
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "user-1",
      iss: issuer,
      aud: audience,
      exp: now + 3600,
      iat: now,
      groups: ["developers"],
    });

    const config: OidcConfig = { issuer, audience };
    const result = await verifyJwt(token, config, undefined, {
      jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sub).toBe("user-1");
      expect(result.value.iss).toBe(issuer);
      expect(result.value.groups).toEqual(["developers"]);
    }
  });

  it("rejects a token with wrong issuer using local JWKS", async () => {
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "user-1",
      iss: "https://evil.com",
      aud: audience,
      exp: now + 3600,
      iat: now,
    });

    const config: OidcConfig = { issuer, audience };
    const result = await verifyJwt(token, config, undefined, {
      jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
    }
  });

  it("rejects a token with wrong audience using local JWKS", async () => {
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "user-1",
      iss: issuer,
      aud: "wrong-audience",
      exp: now + 3600,
      iat: now,
    });

    const config: OidcConfig = { issuer, audience };
    const result = await verifyJwt(token, config, undefined, {
      jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an expired token using local JWKS", async () => {
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "user-1",
      iss: issuer,
      aud: audience,
      exp: now - 300, // expired 5 minutes ago
      iat: now - 3600,
    });

    const config: OidcConfig = { issuer, audience, clockSkewSec: 10 };
    const result = await verifyJwt(token, config, undefined, {
      jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("resolves roles from group mapping", async () => {
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "admin-user",
      iss: issuer,
      aud: audience,
      exp: now + 3600,
      iat: now,
      groups: ["platform-admins"],
    });

    const config: OidcConfig = { issuer, audience };
    const mapping: GroupRoleMapping = { "platform-admins": "admin" };
    const result = await verifyJwt(token, config, mapping, {
      jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.groups).toEqual(["platform-admins"]);
    }
  });

  it("rejects token signed with wrong key using local JWKS", async () => {
    const wrongKeyPair = await generateKeyPair("RS256", { extractable: true });
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken(
      {
        sub: "attacker",
        iss: issuer,
        aud: audience,
        exp: now + 3600,
        iat: now,
      },
      wrongKeyPair,
    );

    const config: OidcConfig = { issuer, audience };
    const result = await verifyJwt(token, config, undefined, {
      jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("enforces required scopes using local JWKS", async () => {
    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "user-1",
      iss: issuer,
      aud: audience,
      exp: now + 3600,
      iat: now,
      scope: "read write",
    });

    const config: OidcConfig = { issuer, audience };
    const jwksOpts = { jwksSet: { keys: [{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }] } };

    // Has required scope
    const resultOk = await verifyJwt(token, config, undefined, {
      ...jwksOpts,
      requiredScopes: ["read"],
    });
    expect(resultOk.ok).toBe(true);

    // Missing required scope
    const resultFail = await verifyJwt(token, config, undefined, {
      ...jwksOpts,
      requiredScopes: ["read", "admin"],
    });
    expect(resultFail.ok).toBe(false);
    if (!resultFail.ok) {
      expect(resultFail.error.message).toContain("Missing required scopes");
    }
  });

  it("returns INVALID_TOKEN when JWKS endpoint is unreachable", async () => {
    const issuer = "https://auth-unreachable.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await signToken({
      sub: "user-1",
      iss: issuer,
      aud: audience,
      exp: now + 3600,
      iat: now,
    });

    const config: OidcConfig = { issuer, audience };
    const result = await verifyJwt(token, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TOKEN");
      expect(result.error.message).toContain("JWT verification failed");
    }
  });

  it("accepts ES256 tokens using local JWKS", async () => {
    const ecKeyPair = await generateKeyPair("ES256", { extractable: true });
    const ecPublicKeyJwk = await exportJWK(ecKeyPair.publicKey);

    const issuer = "https://auth.example.com";
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      sub: "ec-user",
      iss: issuer,
      aud: audience,
      exp: now + 3600,
      iat: now,
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-ec-key" })
      .sign(ecKeyPair.privateKey);

    const config: OidcConfig = { issuer, audience };
    const result = await verifyJwt(token, config, undefined, {
      jwksSet: { keys: [{ ...ecPublicKeyJwk, kid: "test-ec-key", use: "sig" }] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sub).toBe("ec-user");
    }
  });
});

describe("validateJwtClaims", () => {
  it("accepts valid claims", () => {
    const now = Date.now();
    const claims = {
      sub: "user-1",
      iss: "https://auth.example.com",
      aud: "55ndeep",
      exp: Math.floor(now / 1000) + 3600,
      iat: Math.floor(now / 1000),
    };
    const config: OidcConfig = { issuer: "https://auth.example.com", audience: "55ndeep" };
    const result = validateJwtClaims(claims, config);
    expect(result.ok).toBe(true);
  });

  it("rejects expired claims", () => {
    const now = Date.now();
    const claims = {
      sub: "user-1",
      iss: "https://auth.example.com",
      aud: "55ndeep",
      exp: Math.floor(now / 1000) - 300,
      iat: Math.floor(now / 1000) - 3600,
    };
    const config: OidcConfig = { issuer: "https://auth.example.com", audience: "55ndeep" };
    const result = validateJwtClaims(claims, config);
    expect(result.ok).toBe(false);
  });

  it("rejects wrong issuer", () => {
    const now = Date.now();
    const claims = {
      sub: "user-1",
      iss: "https://evil.com",
      aud: "55ndeep",
      exp: Math.floor(now / 1000) + 3600,
      iat: Math.floor(now / 1000),
    };
    const config: OidcConfig = { issuer: "https://auth.example.com", audience: "55ndeep" };
    const result = validateJwtClaims(claims, config);
    expect(result.ok).toBe(false);
  });
});
