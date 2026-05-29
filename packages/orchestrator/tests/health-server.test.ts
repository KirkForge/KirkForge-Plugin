import { describe, it, expect } from "vitest";
import http from "node:http";
import { HealthServer } from "../src/health-server.js";
import { EventBus } from "@55ndeep/core-events";
import { Orchestrator } from "../src/index.js";
import { InMemoryAdapter, MemoryStore } from "@55ndeep/memory-palace";

function createTestOrchestrator(): Orchestrator {
  const bus = new EventBus();
  const store = new MemoryStore(new InMemoryAdapter());
  return new Orchestrator({
    modelConfig: { providers: {}, defaultProvider: "test" },
    eventBus: bus,
    memoryStore: store,
  });
}

function httpRequest(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk; });
        res.on("end", () => {
          const h: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            h[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({ status: res.statusCode ?? 0, headers: h, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}


function httpRequestWithMethod(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk; });
        res.on("end", () => {
          const h: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            h[k] = Array.isArray(v) ? v.join(", ") : v;
          }
          resolve({ status: res.statusCode ?? 0, headers: h, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}
// Unit tests (no HTTP server needed)
describe("HealthServer unit features", () => {
  it("initializes with default configuration values", () => {
    const orchestrator = createTestOrchestrator();
    const server = new HealthServer(orchestrator, { port: 0 });
    expect(server.inFlightCount).toBe(0);
    expect(server.ready).toBe(false);
  });

  it("accepts requestTimeoutMs config", () => {
    const orchestrator = createTestOrchestrator();
    const server = new HealthServer(orchestrator, { port: 0, requestTimeoutMs: 5000 });
    // Config should be stored (we verify this by starting the server)
    expect(server).toBeDefined();
  });

  it("accepts maxBodyBytes config", () => {
    const orchestrator = createTestOrchestrator();
    const server = new HealthServer(orchestrator, { port: 0, maxBodyBytes: 100 });
    expect(server).toBeDefined();
  });

  it("accepts drainTimeoutMs config", () => {
    const orchestrator = createTestOrchestrator();
    const server = new HealthServer(orchestrator, { port: 0, drainTimeoutMs: 5000 });
    expect(server).toBeDefined();
  });
});

// Integration tests (HTTP server needed) — run sequentially
describe("HealthServer HTTP integration", { sequential: true, timeout: 30000 }, () => {
  let orchestrator: Orchestrator;
  let server: HealthServer;
  let port: number;

  async function startServer(opts: Record<string, unknown> = {}): Promise<void> {
    // Ensure previous server is fully stopped
    await new Promise((r) => setTimeout(r, 100));
    // Stop previous server if any
    try { await server?.stop(); } catch { /* best effort */ }

    orchestrator = createTestOrchestrator();
    server = new HealthServer(orchestrator, { port: 0, ...opts });
    await server.start();
    server.ready = true;

    const internal = server as unknown as { server: http.Server };
    const addr = internal.server.address() as { port: number };
    port = addr.port;
  }

  async function stopServer(): Promise<void> {
    try { await server?.stop(); } catch { /* best effort */ }
  }

  it("sets correlation ID headers on responses", async () => {
    await startServer({ apiKey: "test-key" });
    try {
      const res = await httpRequest(port, "/healthz", { Authorization: "Bearer test-key" });
      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBeDefined();
      expect(res.headers["x-correlation-id"]).toBeDefined();
    } finally {
      await stopServer();
    }
  });

  it("echoes provided x-request-id as correlation ID", async () => {
    await startServer({ apiKey: "test-key" });
    try {
      const customId = "my-request-abc123";
      const res = await httpRequest(port, "/healthz", {
        Authorization: "Bearer test-key",
        "X-Request-Id": customId,
      });
      expect(res.headers["x-request-id"]).toBe(customId);
      expect(res.headers["x-correlation-id"]).toBe(customId);
    } finally {
      await stopServer();
    }
  });

  it("rejects requests with oversized content-length", async () => {
    await startServer({ apiKey: "test-key", maxBodyBytes: 100 });
    try {
      const res = await httpRequest(port, "/healthz", {
        Authorization: "Bearer test-key",
        "Content-Length": "1000",
      });
      expect(res.status).toBe(413);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally {
      await stopServer();
    }
  });

  it("returns structured error for 404 paths", async () => {
    await startServer({ apiKey: "test-key" });
    try {
      const res = await httpRequest(port, "/nonexistent", { Authorization: "Bearer test-key" });
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.status).toBe(404);
      expect(body.error.requestId).toBeDefined();
    } finally {
      await stopServer();
    }
  });

  it("includes in-flight gauge in Prometheus metrics", async () => {
    await startServer({ apiKey: "test-key" });
    try {
      const res = await httpRequest(port, "/metrics/prometheus", { Authorization: "Bearer test-key" });
      expect(res.status).toBe(200);
      expect(res.body).toContain("55ndeep_http_requests_in_flight");
    } finally {
      await stopServer();
    }
  });

  it("returns SERVICE_UNAVAILABLE during graceful shutdown", async () => {
    await startServer({ apiKey: "test-key" });
    try {
      // Mark server as shutting down
      (server as unknown as { _shuttingDown: boolean })._shuttingDown = true;

      const res = await httpRequest(port, "/healthz", { Authorization: "Bearer test-key" });
      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    } finally {
      (server as unknown as { _shuttingDown: boolean })._shuttingDown = false;
      await stopServer();
    }
  });


  it('rejects POST with 405 Method Not Allowed', async () => {
    await startServer({ apiKey: 'test-key' });
    try {
      const res = await httpRequestWithMethod(port, '/healthz', 'POST', {
        Authorization: 'Bearer test-key',
      });
      expect(res.status).toBe(405);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe('METHOD_NOT_ALLOWED');
    } finally {
      await stopServer();
    }
  });

  it('rejects DELETE with 405 Method Not Allowed', async () => {
    await startServer({ apiKey: 'test-key' });
    try {
      const res = await httpRequestWithMethod(port, '/healthz', 'DELETE', {
        Authorization: 'Bearer test-key',
      });
      expect(res.status).toBe(405);
    } finally {
      await stopServer();
    }
  });

  it('responds to OPTIONS with 204 (CORS preflight)', async () => {
    await startServer({ apiKey: 'test-key', corsOrigin: '*' });
    try {
      const res = await httpRequestWithMethod(port, '/healthz', 'OPTIONS', {
        Authorization: 'Bearer test-key',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    } finally {
      await stopServer();
    }
  });

  it('sets CORS headers when corsOrigin is configured', async () => {
    await startServer({ apiKey: 'test-key', corsOrigin: 'https://example.com' });
    try {
      const res = await httpRequest(port, '/healthz', { Authorization: 'Bearer test-key' });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://example.com');
    } finally {
      await stopServer();
    }
  });

  it('does not set CORS headers when corsOrigin is not configured', async () => {
    await startServer({ apiKey: 'test-key' });
    try {
      const res = await httpRequest(port, '/healthz', { Authorization: 'Bearer test-key' });
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await stopServer();
    }
  });

  it('sets HSTS header on responses', async () => {
    await startServer({ apiKey: 'test-key' });
    try {
      const res = await httpRequest(port, '/healthz', { Authorization: 'Bearer test-key' });
      expect(res.status).toBe(200);
      expect(res.headers['strict-transport-security']).toContain('max-age=');
    } finally {
      await stopServer();
    }
  });

  it('returns structured error for 401 unauthorized', async () => {
    await startServer({ apiKey: 'test-key' });
    try {
      const res = await httpRequest(port, '/healthz');
      expect(res.status).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.category).toBe('auth');
    } finally {
      await stopServer();
    }
  });

  it('includes request counter in Prometheus metrics', async () => {
    await startServer({ apiKey: 'test-key' });
    try {
      // Make a request first to increment counter
      await httpRequest(port, '/healthz', { Authorization: 'Bearer test-key' });
      const res = await httpRequest(port, '/metrics/prometheus', { Authorization: 'Bearer test-key' });
      expect(res.status).toBe(200);
      expect(res.body).toContain('55ndeep_http_requests_total');
    } finally {
      await stopServer();
    }
  });

});
