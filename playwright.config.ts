import { defineConfig } from "@playwright/test";

/**
 * E2E runs against a dev server on :3000 with a real local database.
 * Credentials come from E2E_EMAIL / E2E_PASSWORD (see .env.local).
 *
 *   npx dotenv -e .env.local -- npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
