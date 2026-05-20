import { NDeepConfigSchema, type NDeepConfig } from "@55ndeep/core-schemas";
import { ConfigError } from "@55ndeep/core-errors";
import { ok, err, type Result } from "@55ndeep/core-types";
import { readFileSync, existsSync } from "fs";
import { resolve, relative, isAbsolute } from "path";

const DEFAULTS: NDeepConfig = {
  workspace: ".",
  orchestrator: { maxConcurrentWorkers: 4, retryAttempts: 3, retryDelayMs: 1000 },
  tools: {
    eslint: { enabled: true },
    secdev: { enabled: true },
    gitnexus: { enabled: true },
    graphify: { enabled: false },
  },
  logging: { level: "info", format: "json" },
  memory: { path: ".55ndeep/memory", retentionDays: 30 },
};

const CONFIG_ENV_KEYS = ["55NDEEP_CONFIG", "NDEEP_CONFIG", "NEEP_CONFIG"];

export class ConfigService {
  private _config: NDeepConfig;

  private constructor(config: NDeepConfig) {
    this._config = config;
  }

  /** Create from an explicit config object (no file/env loading). */
  static fromConfig(config: NDeepConfig): ConfigService {
    return new ConfigService(config);
  }

  /** Load from env/file with full validation. Returns Result — never throws.
   *  Does NOT mutate process.env. Callers must manage their own config path tracking. */
  static load(configPath?: string): Result<ConfigService, ConfigError> {

    let merged = { ...DEFAULTS };
    let resolvedPath: string | undefined;
    for (const key of CONFIG_ENV_KEYS) {
      const val = process.env[key];
      if (val && existsSync(val)) { resolvedPath = val; break; }
    }

    if (resolvedPath) {
      try {
        const raw = JSON.parse(readFileSync(resolvedPath, "utf-8"));
        merged = deepMerge(merged, raw);
      } catch (e) {
        return err(new ConfigError(`Failed to load config from ${resolvedPath}`, { cause: String(e) }));
      }
    }

    const parsed = NDeepConfigSchema.safeParse(merged);
    if (!parsed.success) {
      return err(new ConfigError(`Config validation failed: ${parsed.error.message}`, { issues: parsed.error.issues }));
    }

    return ok(new ConfigService(parsed.data));
  }

  /** @deprecated Use ConfigService.load() instead — returns Result, never throws. */
  static loadSafe(configPath?: string): Result<ConfigService, ConfigError> {
    return ConfigService.load(configPath);
  }

  get(): NDeepConfig {
    return structuredClone(this._config);
  }

  /**
   * Resolve a subPath relative to the configured workspace.
   * Throws if the resolved path escapes the workspace directory.
   */
  getPath(subPath: string): string {
    const resolved = resolve(this._config.workspace, subPath);
    const workspaceAbs = resolve(this._config.workspace);
    const rel = relative(workspaceAbs, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`ConfigService.getPath: "${subPath}" escapes workspace "${workspaceAbs}"`);
    }
    return resolved;
  }
}

function deepMerge<T extends Record<string, unknown>>(base: T, overrides: Partial<T>): T {
  const result = { ...base } as Record<string, unknown>;
  for (const [key, val] of Object.entries(overrides)) {
    if (val !== undefined && typeof val === "object" && !Array.isArray(val) && val !== null) {
      result[key] = deepMerge((result[key] as Record<string, unknown>) ?? {}, val as Record<string, unknown>);
    } else if (val !== undefined) {
      result[key] = val;
    }
  }
  return result as T;
}

// ── Backward-compatible exports ──────────────────────────────────────────
export { validateEnvVars, resolveMemoryPath } from "./55ndeep-config.js";
export type { NDeepLegacyConfig } from "./55ndeep-config.js";

// ── New enterprise config exports ────────────────────────────────────────
export {
  OrchestratorConfigSchema,
  ToolConfigSchema,
  LoggingConfigSchema,
  MemoryConfigSchema,
  ProviderConfigSchema,
  ProvidersMapSchema,
  AppConfigSchema,
  validateConfig,
  validatePartialConfig,
  validateProvider,
  defaultAppConfig,
} from "./55ndeep-config.js";

export type {
  ValidatedConfig,
  AppConfig,
} from "./55ndeep-config.js";
