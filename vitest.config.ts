import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // PGlite instances are heavy (WASM); keep parallelism modest.
    maxWorkers: 4,
  },
});
