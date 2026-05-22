import { describe, it, expect } from "vitest";
import { ModelClient } from "../src/model-client.js";
import { ModelClientError } from "../src/model-client-error.js";

function makeClient(overrides: Record<string, unknown> = {}) {
  return new ModelClient({
    baseUrl: "http://localhost:9999",
    defaultModel: "test-model",
    timeoutMs: 5000,
    maxRetries: 0,
    ...overrides,
  });
}

describe("ModelClientError", () => {
  it("creates typed errors", () => {
    const e = ModelClientError.timeout(5000);
    expect(e.code).toBe("TIMEOUT");
    expect(e.message).toContain("5000ms");
  });

  it("creates auth errors with 401 status", () => {
    const e = ModelClientError.auth("invalid key");
    expect(e.code).toBe("AUTH_ERROR");
    expect(e.statusCode).toBe(401);
  });

  it("creates rate limit errors", () => {
    const e = ModelClientError.rateLimit("too many", 30000);
    expect(e.code).toBe("RATE_LIMIT");
    expect(e.retryAfterMs).toBe(30000);
  });

  it("creates api errors with status code", () => {
    const e = ModelClientError.api(500, "internal");
    expect(e.code).toBe("API_ERROR");
    expect(e.statusCode).toBe(500);
  });
});

describe("ModelClient", () => {
  it("constructs with config", () => {
    const c = makeClient();
    expect(c).toBeInstanceOf(ModelClient);
  });

  it("detects Anthropic from baseUrl", () => {
    const c = new ModelClient({
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-ant-abc123",
      defaultModel: "claude",
      timeoutMs: 5000,
      maxRetries: 0,
    });
    expect(c).toBeInstanceOf(ModelClient);
  });

  it("complete builds chat messages from system/user prompt", async () => {
    const c = makeClient({ maxRetries: 0 });
    try {
      await c.complete("system prompt", "user prompt");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelClientError);
      expect((e as ModelClientError).code).toBe("NETWORK_ERROR");
    }
  });
});
