/**
 * A guarded wrapper around `prisma migrate reset`.
 *
 * The old `db:reset` script was `prisma migrate reset --force` with nothing in front of it. One
 * mistyped environment, or one terminal where a production `DIRECT_URL` was still exported, and
 * a distributor's entire business would be gone — not corrupted, gone, with the confirmation
 * prompt already suppressed by `--force`.
 *
 * The command still exists because a developer genuinely needs it several times a week. What
 * changes is that it now has to get past the same two checks the demo seed does: what the
 * operator declared (`APP_ENV`), and where the database actually is.
 */
import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { guardDatabaseTarget, guardDestructive } from './guard';

loadEnv();

guardDestructive('destructive reset');
guardDatabaseTarget('destructive reset');

console.log('Resetting the local development database…\n');

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['prisma', 'migrate', 'reset', '--force', '--skip-seed'],
  { stdio: 'inherit', env: process.env },
);

if (result.status !== 0) process.exit(result.status ?? 1);

/*
 * Re-provision the application role, because the reset just removed its rights.
 *
 * `migrate reset` drops and recreates schema `public`. That takes the schema-level `USAGE` grant
 * and the default privileges with it — they were never in a migration, they were in the Docker
 * volume's one-time init script. The migrations replay, every table comes back, and the
 * application answers "permission denied for schema public" on every page.
 *
 * It cost most of an afternoon to diagnose once, presenting as twenty-nine unrelated end-to-end
 * failures. A reset that leaves the database unusable is not a reset, so the repair is part of
 * the command rather than a step somebody has to know about.
 */
console.log('\nRe-granting the application role…');

const provision = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['tsx', 'scripts/provision-app-role.ts'],
  { stdio: 'inherit', env: process.env },
);

if (provision.status !== 0) {
  console.error('\nThe reset succeeded but the role could not be re-granted.');
  console.error('Run `pnpm ops:provision-role` and read what it says.\n');
  process.exit(provision.status ?? 1);
}

console.log('\nDone. Run `pnpm db:seed` to load the demo data.');
