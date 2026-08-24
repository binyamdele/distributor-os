import { execSync } from 'node:child_process';

/**
 * Loads the demo seed before the browser tests run, so they assert against known data.
 *
 * The seed is idempotent (it upserts on stable ids), so this is safe to run repeatedly against
 * a development database.
 *
 * **Skipped entirely when the suite is pointed at an external deployment.** `prisma migrate
 * deploy` and the seed both act on whatever `DATABASE_URL` names locally, which is almost never
 * the database behind the host under test — so running them would migrate and seed the wrong
 * database while appearing to prepare the right one. Worse, if the two ever *did* coincide, it
 * would write demo data into a deployed environment as a side effect of running a test.
 *
 * Preparing a staging environment is a deliberate act with its own commands, not a hook.
 */
export default function globalSetup(): void {
  if (process.env.PLAYWRIGHT_BASE_URL) {
    console.log(
      '\n  Pointed at an external deployment — skipping migrate and seed.\n' +
        '  The suite writes: it creates customers, moves stock and records payments.\n',
    );
    return;
  }

  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  execSync('npx tsx prisma/seed.ts', { stdio: 'inherit' });
}
