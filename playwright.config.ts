import { defineConfig } from '@playwright/test';

/**
 * E2E config. Tests load the *built* extension from `.output/chrome-mv3`, so run
 * `pnpm build` first (`pnpm test:e2e` and the CI test script do this). A tiny static server
 * hosts the demo page over http so the content scripts inject (they do not run on
 * file:// without "allow file access").
 *
 * Extensions require a real Chromium (not the headless shell); we use
 * `channel: 'chromium'`, which supports extensions in the new headless mode.
 * Set HEADED=1 to watch it run.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  webServer: {
    command: 'python3 -m http.server 5319 --directory demo',
    port: 5319,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://localhost:5319',
    actionTimeout: 15_000,
  },
});
