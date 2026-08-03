import { defineConfig, devices } from '@playwright/test';

/**
 * Fork-owned Playwright config for the deployment golden-path test.
 *
 * Targets a running stack (the production Docker images in CI, or a local
 * `docker compose` / dev stack). Both URLs are injectable so the same suite can
 * later be pointed at a Railway preview/staging deployment (issue #24, item 5).
 */
const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  // One golden path; fail fast and do not paper over flakiness with retries.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: WEB_BASE_URL,
    // Force English so message-key assertions are stable (baseLocale = 'en').
    locale: 'en-US',
    // Legible failures: screenshot + trace kept only when a test fails.
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
