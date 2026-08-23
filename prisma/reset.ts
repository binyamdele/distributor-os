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

console.log('\nDone. Run `pnpm db:seed` to load the demo data.');
