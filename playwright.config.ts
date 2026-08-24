import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv();

const PORT = 3100;

/**
 * Where the suite points, and the one guard that matters.
 *
 * `PLAYWRIGHT_BASE_URL` aims the whole suite at an already-running deployment — a staging host,
 * or the container image being released — instead of starting a local server. That makes this
 * the transactional smoke test: it signs in, raises an inquiry, quotes it, approves, accepts,
 * creates an order, reserves stock, submits payment evidence, confirms it, picks, delivers and
 * reads the dashboard.
 *
 * **This suite writes.** It is not a read-only health check and must never be described as one:
 * it creates customers, moves stock and records payments. `pnpm ops:verify-deployment` is the
 * read-only one, and the two are deliberately separate commands.
 *
 * So it refuses production outright. Not a warning, not a flag to override — a thrown error
 * before a single test is collected. The failure mode being prevented is test data in a
 * distributor's real ledger, which cannot be undone by noticing afterwards.
 */
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL?.replace(/\/$/, '');

if (externalBaseUrl && process.env.APP_ENV === 'production') {
  throw new Error(
    'Refusing to run the end-to-end suite against APP_ENV=production.\n' +
      'It creates customers, moves stock and records payments. Use a staging deployment with\n' +
      'synthetic data, or `pnpm ops:verify-deployment` for a read-only check.',
  );
}

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
    baseURL: externalBaseUrl ?? `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 5'] } },
  ],
  /*
   * Skipped entirely when pointed at an external deployment: there is nothing to start, and
   * building a local copy would silently test the wrong thing.
   */
  webServer: externalBaseUrl
    ? undefined
    : {
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
