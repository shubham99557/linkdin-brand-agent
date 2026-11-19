import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:8788", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build:web && npx tsx tests/e2e/server.ts",
    url: "http://127.0.0.1:8788/api/health",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
