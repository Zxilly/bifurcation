import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "./test-results",
  use: {
    browserName: "chromium",
    channel: process.env.BIFURCATION_E2E_CHANNEL || undefined,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    // Authentication pages and machine details contain real test credentials.
    // Do not retain them in screenshots, recordings or traces.
    screenshot: "off",
    video: "off",
    trace: "off",
  },
});
