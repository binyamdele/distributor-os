import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv();

const PORT = 3100;

/**
 * End-to-end tests run against the development database with the demo seed loaded, because the
 * thing being tested is the product a pilot user would touch — the real login, the real
 * server-rendered tables, the real permission checks.
 *
 * The mobile viewport is not decoration. Salespeople in Addis will use this on a phone, on a
 * connection that makes a broken layout expensive, so at least one path is asserted there.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  webServer: {
    /*
     * A production build, not `next dev`.
     *
     * In development, the first request to each route compiles it on demand, which took longer
     * than any sensible assertion timeout and produced failures that looked like product bugs
     * and were not. It is also closer to what a pilot user would actually run.
     */
    command: `npx next build && npx next start --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
  },
});
