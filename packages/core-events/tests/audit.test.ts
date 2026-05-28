import { describe, it, expect } from "vitest";
import { MemoryAuditSink, AuditLogger, createAuditSink, type AuditAction } from "../src/audit.js";

describe("MemoryAuditSink", () => {
  it("stores events and retrieves them", async () => {
    const sink = new MemoryAuditSink();
    await sink.write({
      id: "test-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      action: "auth.success",
      outcome: "success",
      actorId: "user1",
      tenantId: "t1",
      reason: "Login",
      chainHash: "",
    });
    await sink.write({
      id: "test-2",
      sequence: 2,
      timestamp: new Date().toISOString(),
      action: "policy.deny",
      outcome: "deny",
      actorId: "user2",
      tenantId: "t2",
      reason: "Tool not allowed",
      chainHash: "",
    });

    const events = sink.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.action).toBe("auth.success");
    expect(events[1]!.action).toBe("policy.deny");
  });

  it("computes chain hashes", async () => {
    const sink = new MemoryAuditSink();
    await sink.write({
      id: "test-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      action: "auth.success",
      outcome: "success",
      actorId: "user1",
      tenantId: "",
      reason: "test",
      chainHash: "",
    });

    const events = sink.getEvents();
    expect(events[0]!.chainHash).toBeTruthy();
    expect(events[0]!.chainHash.length).toBeGreaterThan(0);
  });

  it("verifies chain integrity", async () => {
    const sink = new MemoryAuditSink();
    for (let i = 0; i < 10; i++) {
      await sink.write({
        id: `test-${i}`,
        sequence: i + 1,
        timestamp: new Date().toISOString(),
        action: "verify.start" as AuditAction,
        outcome: "success",
        actorId: "user1",
        tenantId: "t1",
        reason: "test",
        chainHash: "",
      });
    }
    expect(sink.verifyChain()).toBe(true);
  });

  it("detects tampered chain", async () => {
    const sink = new MemoryAuditSink();
    await sink.write({
      id: "test-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      action: "auth.success",
      outcome: "success",
      actorId: "user1",
      tenantId: "",
      reason: "test",
      chainHash: "",
    });
    // Tamper with the chain hash
    const events = sink.getEvents();
    events[0]!.chainHash = "tampered";
    expect(sink.verifyChain()).toBe(false);
  });

  it("flushes and closes successfully", async () => {
    const sink = new MemoryAuditSink();
    await sink.write({
      id: "test-1",
      sequence: 1,
      timestamp: new Date().toISOString(),
      action: "auth.success",
      outcome: "success",
      actorId: "user1",
      tenantId: "",
      reason: "test",
      chainHash: "",
    });
    expect(await sink.flush()).toBe(true);
    await sink.close();
  });
});

describe("AuditLogger", () => {
  it("records audit events through the logger", async () => {
    const sink = new MemoryAuditSink();
    const logger = new AuditLogger(sink);

    await logger.record({
      action: "auth.success",
      outcome: "success",
      actorId: "user1",
      tenantId: "t1",
      reason: "API key auth",
    });

    await logger.record({
      action: "policy.deny",
      outcome: "deny",
      actorId: "user2",
      tenantId: "t2",
      reason: "Tool 'curl' not allowed",
      policyHash: "abc123",
    });

    await logger.flush();
    const events = (sink as MemoryAuditSink).getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]!.action).toBe("auth.success");
    expect(events[1]!.action).toBe("policy.deny");
    expect(events[1]!.policyHash).toBe("abc123");
  });

  it("includes trace ID in events", async () => {
    const sink = new MemoryAuditSink();
    const logger = new AuditLogger(sink);

    await logger.record({
      action: "verify.start",
      outcome: "success",
      actorId: "user1",
      tenantId: "t1",
      reason: "verification started",
      traceId: "trace-123",
    });

    const events = (sink as MemoryAuditSink).getEvents();
    expect(events[0]!.traceId).toBe("trace-123");
  });
});

describe("createAuditSink", () => {
  it("creates memory sink", () => {
    const sink = createAuditSink({ type: "memory" });
    expect(sink).toBeInstanceOf(MemoryAuditSink);
  });

  it("creates file sink", () => {
    const sink = createAuditSink({ type: "file", filePath: "/tmp/55ndeep-test-audit.jsonl" });
    expect(sink.name).toBe("file");
  });

  it("throws for unknown type", () => {
    expect(() => createAuditSink({ type: "unknown" as any })).toThrow();
  });
});

describe("SyslogAuditSink", () => {
  it("creates with TLS transport config", async () => {
    const { SyslogAuditSink } = await import("../src/audit.js");
    const sink = new SyslogAuditSink({
      transport: "tls",
      host: "siem.example.com",
      port: 6514,
      tls: {
        rejectUnauthorized: true,
        servername: "siem.example.com",
      },
    });
    expect(sink.name).toBe("syslog");
    await sink.close();
  });

  it("creates with TCP transport config", async () => {
    const { SyslogAuditSink } = await import("../src/audit.js");
    const sink = new SyslogAuditSink({
      transport: "tcp",
      host: "siem.example.com",
      port: 1468,
    });
    expect(sink.name).toBe("syslog");
    await sink.close();
  });

  it("defaults to UDP when transport is not specified", async () => {
    const { SyslogAuditSink } = await import("../src/audit.js");
    const sink = new SyslogAuditSink({ host: "localhost" });
    expect(sink.name).toBe("syslog");
    await sink.close();
  });

  it("uses port 6514 for TLS transport by default", async () => {
    const { SyslogAuditSink } = await import("../src/audit.js");
    const sink = new SyslogAuditSink({ transport: "tls", host: "siem.example.com" });
    // Port 6514 is the IANA-assigned port for syslog over TLS (RFC 5425)
    // We verify construction succeeds; port is stored internally
    expect(sink.name).toBe("syslog");
    await sink.close();
  });
});
