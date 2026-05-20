// ── Legacy config helpers (deprecated — use ConfigService instead) ──────

/** @deprecated Use ConfigService instead */
export interface NDeepLegacyConfig {
  workspace: string;
  memoryPath: string;
}

/** @deprecated Use ConfigService.getPath() instead */
export function resolveMemoryPath(cwd?: string): string {
  return `${cwd ?? process.cwd()}/.55ndeep/memory`;
}

/** @deprecated Validation handled by ConfigService.load() + Zod schemas */
export function validateEnvVars(): string[] {
  // Model config validation is handled by buildModelConfig()
  return [];
}
