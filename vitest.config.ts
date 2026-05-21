import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    maxConcurrency: 1,
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    sequence: { concurrent: false },
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "packages/**/tests/**/*.test.ts", "e2e/**/*.test.ts"],
    coverage: {
      enabled: false,
      provider: "v8",
      include: ["packages/**/src/**", "apps/**/src/**"],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
});

