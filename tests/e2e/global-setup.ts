import { execSync } from 'node:child_process';

/**
 * Loads the demo seed before the browser tests run, so they assert against known data.
 *
 * The seed is idempotent (it upserts on stable ids), so this is safe to run repeatedly against
 * a development database.
 */
export default function globalSetup(): void {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
}
