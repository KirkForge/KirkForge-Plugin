import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyJwt, clearJwksCache } from "../src/jwt-verify.js";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import type { OidcConfig, GroupRoleMapping } from "../src/index.js";

describe("verifyJwt", () => {
  const issuer = "https://auth.example.com";
  const audience = "55ndeep";

  let rsaKeyPair: CryptoKeyPair;
  let rsaPublicKeyJwk: Record<string, unknown>;

  beforeEach(async () => {
    clearJwksCache();
    // Generate an RSA key pair for signing tokens
    rsaKeyPair = await generateKeyPair("RS256", { extractable: true });
    const { publicKey } = rsaKeyPair;
    rsaPublicKeyJwk = await exportJWK(publicKey);
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

  // Helper to mock JWKS endpoint
  function mockJwksEndpoint(keys: Record<string, unknown>[]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/.well-known/openid-configuration")) {
        return new Response(
          JSON.stringify({
            issuer,
            jwks_uri: `${issuer}/.well-known/jwks.json`,
            token_endpoint: `${issuer}/token`,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (urlStr.includes("/.well-known/jwks.json")) {
        return new Response(JSON.stringify({ keys }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Fall through to real fetch for other URLs
      return originalFetch(url, init);
    });
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  it("accepts a valid JWT with matching issuer and audience", async () => {
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
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
      const result = await verifyJwt(token, config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sub).toBe("user-1");
        expect(result.value.iss).toBe(issuer);
        expect(result.value.groups).toEqual(["developers"]);
      }
    } finally {
      restore();
    }
  });

  it("rejects a token with wrong issuer", async () => {
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await signToken({
        sub: "user-1",
        iss: "https://evil.com",
        aud: audience,
        exp: now + 3600,
        iat: now,
      });

      const config: OidcConfig = { issuer, audience };
      const result = await verifyJwt(token, config);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_TOKEN");
      }
    } finally {
      restore();
    }
  });

  it("rejects a token with wrong audience", async () => {
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await signToken({
        sub: "user-1",
        iss: issuer,
        aud: "wrong-audience",
        exp: now + 3600,
        iat: now,
      });

      const config: OidcConfig = { issuer, audience };
      const result = await verifyJwt(token, config);
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it("rejects an expired token", async () => {
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
      const now = Math.floor(Date.now() / 1000);
      const token = await signToken({
        sub: "user-1",
        iss: issuer,
        aud: audience,
        exp: now - 300, // expired 5 minutes ago
        iat: now - 3600,
      });

      const config: OidcConfig = { issuer, audience, clockSkewSec: 10 };
      const result = await verifyJwt(token, config);
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it("resolves roles from group mapping", async () => {
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
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
      const result = await verifyJwt(token, config, mapping);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.groups).toEqual(["platform-admins"]);
      }
    } finally {
      restore();
    }
  });

  it("rejects token signed with wrong key", async () => {
    // Mock with the correct JWKS key, but sign with a different key
    const wrongKeyPair = await generateKeyPair("RS256", { extractable: true });
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
      const now = Math.floor(Date.now() / 1000);
      // Sign with the wrong key (but use the same kid)
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
      const result = await verifyJwt(token, config);
      expect(result.ok).toBe(false);
    } finally {
      restore();
    }
  });

  it("enforces required scopes", async () => {
    const restore = mockJwksEndpoint([{ ...rsaPublicKeyJwk, kid: "test-key-1", use: "sig" }]);
    try {
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

      // Has required scope
      const resultOk = await verifyJwt(token, config, undefined, {
        requiredScopes: ["read"],
      });
      expect(resultOk.ok).toBe(true);

      // Missing required scope
      const resultFail = await verifyJwt(token, config, undefined, {
        requiredScopes: ["read", "admin"],
      });
      expect(resultFail.ok).toBe(false);
      if (!resultFail.ok) {
        expect(resultFail.error.message).toContain("Missing required scopes");
      }
    } finally {
      restore();
    }
  });

  it("returns INVALID_TOKEN when JWKS endpoint is unreachable", async () => {
    // No mock — all fetches will fail
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("Network error")));

    try {
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("accepts ES256 tokens", async () => {
    const ecKeyPair = await generateKeyPair("ES256", { extractable: true });
    const ecPublicKeyJwk = await exportJWK(ecKeyPair.publicKey);

    const restore = mockJwksEndpoint([{ ...ecPublicKeyJwk, kid: "test-ec-key", use: "sig" }]);
    try {
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
      const result = await verifyJwt(token, config);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sub).toBe("ec-user");
      }
    } finally {
      restore();
    }
  });
});
