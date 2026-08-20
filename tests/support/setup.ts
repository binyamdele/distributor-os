import { config as loadEnv } from 'dotenv';
import { execSync } from 'node:child_process';

/**
 * Integration-test bootstrap.
 *
 * Points the process at the test database *before* any module imports the Prisma client, then
 * brings its schema up to date. Running the real migrations rather than `db push` is
 * deliberate: the RLS policies live in a hand-written migration, and a test suite that skipped
 * them would be asserting tenancy against a database that does not have it.
 */
loadEnv();

const testUrl = process.env.TEST_DATABASE_URL;
const testDirectUrl = process.env.TEST_DIRECT_URL;

if (!testUrl || !testDirectUrl) {
  throw new Error(
    'TEST_DATABASE_URL and TEST_DIRECT_URL must be set. Copy .env.example to .env and run `pnpm db:up`.',
  );
}

// The application connects as the non-superuser role, so RLS applies during the tests exactly
// as it does in the running product.
process.env.DATABASE_URL = testUrl;
process.env.DIRECT_URL = testDirectUrl;

execSync('npx prisma migrate deploy', {
  stdio: 'pipe',
  env: { ...process.env, DATABASE_URL: testDirectUrl, DIRECT_URL: testDirectUrl },
});
