import { defineConfig, devices } from "@playwright/test";

/**
 * G.3.3 / #480 and G.3.8 / #495. One production server, one worker,
 * no retries. RTL specs send `x-ff-dir: rtl`. Waits live in the specs
 * (role/heading), not animation timers.
 */
const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["github"], ["line"]] : "line",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    reducedMotion: "reduce",
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  webServer: {
    command: `pnpm exec next build && pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
