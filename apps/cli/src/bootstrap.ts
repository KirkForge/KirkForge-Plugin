import { EventBus } from "@55ndeep/core-events";
import { Logger } from "@55ndeep/core-logging";
import { ConfigService } from "@55ndeep/core-config";
import { buildModelConfigAsync } from "@55ndeep/model-config";
import { Orchestrator } from "@55ndeep/orchestrator";
import { FileAdapter, MemoryStore } from "@55ndeep/memory-palace";
import { createSecretsManager } from "@55ndeep/core-secrets";
import { initTelemetry, shutdownTelemetry, isTracingEnabled } from "@55ndeep/core-telemetry";
import type { SecretsManager } from "@55ndeep/core-secrets";
import { readFileSync, existsSync } from "fs";
import { URL } from "node:url";

function parseDotEnvLine(line: string): { key: string; value: string } | null {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (trimmed.startsWith("export ")) trimmed = trimmed.slice(7).trim();
  const eqIdx = trimmed.indexOf("=");
  if (eqIdx <= 0) return null;
  let key = trimmed.slice(0, eqIdx).trim();
  let val = trimmed.slice(eqIdx + 1);
  val = val.trim();
  const commentIdx = val.indexOf(" #");
  if (commentIdx >= 0) val = val.slice(0, commentIdx).trimEnd();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  val = val.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  return { key, value: val };
}

// Config loading is explicit — no auto-loading of .env or .55ndeperc from cwd.
// Use createBootstrap({...}) to pass configuration, or set env vars externally.

export const VERSION: string = (() => { try { const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")); return pkg.version ?? "0.0.0"; } catch { return "0.0.0"; } })();
export const ALL_MODES = ["hard-prompt", "schema-contract", "artifact"] as const;

export interface BootstrapOpts {
  provider?: string;
  json?: boolean;
  mode?: string;
  maxTokens?: number;
  temperature?: number;
  /** Disable OpenTelemetry even if OTEL_EXPORTER_OTLP_ENDPOINT is set. */
  noOtel?: boolean;
}

export interface BootstrapResult {
  orchestrator: Orchestrator;
  configService: ConfigService;
  modelConfig: import("@55ndeep/model-config").ModelConfig;
  eventBus: EventBus;
  logger: Logger;
  memoryStore: MemoryStore;
  secretsManager: SecretsManager | null;
  /** Call to gracefully shut down telemetry. */
  shutdown: () => Promise<void>;
}

export async function createBootstrap(opts: BootstrapOpts): Promise<BootstrapResult> {
  const eventBus = new EventBus();
  const logger = new Logger({ level: "info", format: opts.json ? "json" : "human", stream: opts.json ? "stderr" : "stdout" });

  // ── Secrets manager ──────────────────────────────────────────────────
  const secretsManager = createSecretsManager();
  logger.info("[bootstrap] Secrets manager initialized with providers: " +
    ["vault", "aws", "gcp", "env"].filter(p => {
      if (p === "env") return true;
      const e = process.env as Record<string, string | undefined>;
      if (p === "vault") return !!(e.VAULT_ADDR && e.VAULT_TOKEN);
      if (p === "aws") return !!e.AWS_REGION;
      if (p === "gcp") return !!e.GCP_PROJECT_ID;
      return false;
    }).join(", "));

  // ── OpenTelemetry ────────────────────────────────────────────────────
  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otelEndpoint && !opts.noOtel) {
    initTelemetry({
      serviceName: "55ndeep",
      serviceVersion: VERSION,
      otlpEndpoint: otelEndpoint,
      logger,
    });
    logger.info(`[bootstrap] OpenTelemetry exporting to ${otelEndpoint}`);
  }

  // ── Config ───────────────────────────────────────────────────────────
  const configResult = ConfigService.load();
  const configService: ConfigService = configResult.ok
    ? configResult.value
    : ConfigService.fromConfig({
        workspace: ".",
        orchestrator: { maxConcurrentWorkers: 4, retryAttempts: 3, retryDelayMs: 1000 },
        tools: { eslint: { enabled: true }, secdev: { enabled: true }, gitnexus: { enabled: true }, graphify: { enabled: false } },
        logging: { level: "info", format: "json" },
        memory: { path: ".55ndeep/memory", retentionDays: 30 },
      });

  // ── Model config (with secrets resolution) ──────────────────────────
  const env = process.env as Record<string, string | undefined>;
  const modelConfigResult = await buildModelConfigAsync(secretsManager, env);
  if (!modelConfigResult.ok) {
    throw new Error(`Model config error: ${modelConfigResult.error.message}. Set OLLAMA_BASE_URL or provider API keys.`);
  }
  const modelConfig = modelConfigResult.value;
  if (opts.provider) {
    if (!modelConfig.providers[opts.provider]) {
      const available = Object.keys(modelConfig.providers);
      throw new Error(`Provider "${opts.provider}" not found. Available providers: ${available.join(", ")}`);
    }
    modelConfig.defaultProvider = opts.provider;
  }

  if (opts.maxTokens || opts.temperature !== undefined) {
    const key = opts.provider ?? modelConfig.defaultProvider;
    const pc = modelConfig.providers[key];
    if (pc) {
      if (opts.maxTokens) pc.maxTokens = opts.maxTokens;
      if (opts.temperature !== undefined) pc.temperature = opts.temperature;
    }
  }

  // ── Memory ───────────────────────────────────────────────────────────
  const memoryPath = configService.get().memory.path || ".55ndeep/memory.json";
  const memoryAdapter = new FileAdapter(memoryPath);
  const memoryStore = new MemoryStore(memoryAdapter);

  // ── Orchestrator ─────────────────────────────────────────────────────
  const orchestrator = new Orchestrator({
    modelConfig,
    providerKey: opts.provider,
    logger,
    eventBus,
    memoryStore,
  });

  const shutdown = async () => {
    if (isTracingEnabled()) {
      await shutdownTelemetry();
    }
  };

  return { orchestrator, configService, modelConfig, eventBus, logger, memoryStore, secretsManager, shutdown };
}
