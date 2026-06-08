import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { HealthServer } from "../packages/orchestrator/src/health-server.js";
import { EventBus } from "@kirkforge/core-events";
import { Orchestrator } from "../packages/orchestrator/src/index.js";
import { InMemoryAdapter, MemoryStore } from "@kirkforge/memory-palace";

let activeServer: HealthServer | null = null;
let activeOrchestrator: Orchestrator | null = null;
let activeBus: EventBus | null = null;

function makeOrchestrator(): Orchestrator {
  const bus = new EventBus();
  const store = new MemoryStore(new InMemoryAdapter());
  return new Orchestrator({
    modelConfig: { providers: {}, defaultProvider: "test" },
    eventBus: bus,
    memoryStore: store,
  });
}

afterEach(async () => {
  if (activeServer) {
    try {
      await activeServer.stop();
    } catch {
      // best-effort
    }
    activeServer = null;
  }
  if (activeBus) {
    try {
      await activeBus.gracefulShutdown();
    } catch {
      // best-effort
    }
    activeBus = null;
  }
  activeOrchestrator = null;
});

async function startServer(): Promise<{ server: HealthServer; port: number }> {
  const orchestrator = makeOrchestrator();
  activeOrchestrator = orchestrator;
  activeBus = (orchestrator as unknown as { sharedEventBus: EventBus }).sharedEventBus;
  // Use port 0 to let the OS pick a free port. We read it back from
  // server.address() once the listen() callback has fired.
  const server = new HealthServer(orchestrator, {
    port: 0,
    host: "127.0.0.1",
    rateLimitPerSec: 10000, // disable rate limit for the smoke
  });
  await server.start();
  // Sanity-check the server is actually listening before we hand the port back.
  const raw = (server as unknown as { server: { listening: boolean; address: () => { port: number } | null } })
    .server;
  if (!raw.listening) {
    throw new Error("HealthServer not listening after start() resolved");
  }
  const addr = raw.address();
  if (!addr || typeof addr !== "object") {
    throw new Error("Server address not available after start()");
  }
  activeServer = server;
  return { server, port: addr.port };
}

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: "GET", headers, timeout: 5000 },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("e2e: serve graceful shutdown", () => {
  it("exposes /v1/metrics in Prometheus text format", async () => {
    const { port } = await startServer();
    const res = await httpGet(port, "/v1/metrics");
    expect(res.status).toBe(200);
    // Prometheus text format: HELP / TYPE / value lines
    expect(res.body).toMatch(/^# HELP /m);
    expect(res.body).toMatch(/^# TYPE /m);
    // Specific KirkForge metric names that should be present
    expect(res.body).toMatch(/kirkforge_(up|delegations_total|tokens_total|http_requests_total)/);
  });

  it("serves /healthz with 200 while running", async () => {
    const { port } = await startServer();
    const res = await httpGet(port, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
  });

  it("returns 503 for new requests after stop() is initiated", async () => {
    const { server, port } = await startServer();
    // Confirm it's running first
    const before = await httpGet(port, "/healthz");
    expect(before.status).toBe(200);
    // Initiate shutdown. The server flips shuttingDown=true synchronously,
    // but the TCP close happens inside the server.close() callback which
    // waits for in-flight to drain. Use stopInitiated() semantics by
    // reaching into the internal flag.
    (server as unknown as { shuttingDown: boolean }).shuttingDown = true;
    // Give the loop a tick to register the flag
    await new Promise((r) => setImmediate(r));
    const during = await httpGet(port, "/healthz");
    expect(during.status).toBe(503);
    expect(during.body).toContain("SERVICE_UNAVAILABLE");
    // Now actually stop the server (it's already marked shutting down)
    (server as unknown as { shuttingDown: boolean }).shuttingDown = false;
    await server.stop();
  });

  it("stops cleanly within the drain timeout", async () => {
    const { server } = await startServer();
    const start = Date.now();
    await server.stop();
    const elapsed = Date.now() - start;
    // No in-flight requests, so this should be fast (< 1s)
    expect(elapsed).toBeLessThan(1000);
  });
});
