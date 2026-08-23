/**
 * The kill switch.
 *
 * If a P0 is found during the pilot — a cross-tenant leak, a wrong payment truth, stock consumed
 * twice, a wrong monetary total — the correct response is to stop the system creating more of
 * whatever it got wrong, immediately, while somebody works out what happened.
 *
 * The mechanism is deliberately the bluntest thing that works: **revoke the application role's
 * write privileges in PostgreSQL.**
 *
 * Why the database rather than a feature flag:
 *
 *   - It cannot be bypassed. A flag lives in the application; a code path that forgot to check it
 *     keeps writing. A `REVOKE` is enforced by the database for every statement from every
 *     connection, including one somebody opens by hand.
 *   - It needs no deploy. A P0 at four in the afternoon must not wait on a container build.
 *   - **Reads keep working.** Staff can still look things up, Finance can still see what was
 *     confirmed, and the owner can still read the dashboard. The system becomes a record rather
 *     than a participant, which is exactly the state you want while investigating.
 *   - It preserves everything. Nothing is deleted, rolled back or migrated. The data stays as it
 *     was at the moment the switch was thrown, which is what an investigation needs.
 *
 * What it deliberately does not do is pretend to be graceful. In-flight transactions fail, and
 * users will see errors. That is the correct trade when the alternative is processing more money
 * and stock through a system known to be wrong.
 *
 * Usage:
 *   pnpm ops:maintenance --on   --reason "P0: duplicate stock consumption on SO-000123"
 *   pnpm ops:maintenance --off
 *   pnpm ops:maintenance --status
 */
import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';
import { notify } from './notify';

loadEnv();

interface Args {
  on: boolean;
  off: boolean;
  status: boolean;
  reason: string;
  container?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { on: false, off: false, status: false, reason: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--on') args.on = true;
    else if (flag === '--off') args.off = true;
    else if (flag === '--status') args.status = true;
    else if (flag === '--reason' && value) args.reason = value;
    else if (flag === '--container' && value) args.container = value;
  }
  return args;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/**
 * The tables the application writes to.
 *
 * Enumerated from the schema rather than hard-coded, so a table added in a later phase is
 * covered automatically. A kill switch that misses the newest table is a kill switch that does
 * not work on exactly the feature most likely to have the defect.
 */
const REVOKE_SQL = `
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM distributor_app', t);
  END LOOP;
END $$;
`;

/**
 * Restores exactly what the migrations grant, and nothing more.
 *
 * Note what is *not* restored: `UPDATE` and `DELETE` on the append-only tables. Those were
 * revoked deliberately by migration, and a maintenance-mode exit that granted them back would
 * quietly undo the audit-log, ledger and import-record immutability guarantees — turning an
 * incident response into a security regression.
 */
const RESTORE_SQL = `
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  LOOP
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO distributor_app', t);
  END LOOP;

  -- Re-apply the append-only revokes. These are not part of maintenance mode; they are
  -- permanent, and restoring writes must not hand them back.
  REVOKE UPDATE, DELETE ON public.audit_events FROM distributor_app;
  REVOKE UPDATE, DELETE ON public.inventory_movements FROM distributor_app;
  REVOKE UPDATE, DELETE ON public.import_jobs FROM distributor_app;
  REVOKE DELETE ON public.stock_reservations FROM distributor_app;
END $$;
`;

const STATUS_SQL = `
SELECT count(*) FROM information_schema.role_table_grants
 WHERE grantee = 'distributor_app' AND privilege_type = 'INSERT' AND table_schema = 'public';
`;

function psql(args: Args, sql: string): { status: number; out: string; err: string } {
  const url = process.env.DIRECT_URL;
  if (!url) fail('DIRECT_URL must be set: maintenance mode is applied as the database owner.');

  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  const database = parsed.pathname.replace(/^\//, '');

  const result = args.container
    ? spawnSync(
        'docker',
        [
          'exec',
          '-e',
          `PGPASSWORD=${password}`,
          args.container,
          'psql',
          '-U',
          user,
          '-d',
          database,
          '-tAc',
          sql,
        ],
        { encoding: 'utf8' },
      )
    : spawnSync('psql', ['-d', stripPrismaParams(url), '-tAc', sql], { encoding: 'utf8' });

  return {
    status: result.status ?? 1,
    out: (result.stdout ?? '').trim(),
    err: result.stderr ?? '',
  };
}

/** libpq rejects Prisma's `?schema=` parameter outright. */
function stripPrismaParams(url: string): string {
  const parsed = new URL(url);
  const allowed = new Set(['sslmode', 'connect_timeout', 'application_name', 'options']);
  for (const key of [...parsed.searchParams.keys()]) {
    if (!allowed.has(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.status) {
    const result = psql(args, STATUS_SQL);
    if (result.status !== 0) fail(`Could not read grants:\n${result.err}`);

    const writable = Number(result.out);
    console.log('');
    console.log(
      writable === 0
        ? '  MAINTENANCE MODE IS ON — the application cannot write.'
        : `  Normal operation — the application can write to ${writable} tables.`,
    );
    console.log('');
    return;
  }

  if (args.on === args.off) {
    fail('Usage: pnpm ops:maintenance --on --reason "..." | --off | --status');
  }

  if (args.on && !args.reason.trim()) {
    // A kill switch thrown without a recorded reason is one nobody can safely turn off again.
    fail('--reason is required when enabling maintenance mode. Say what the P0 is.');
  }

  const result = psql(args, args.on ? REVOKE_SQL : RESTORE_SQL);
  if (result.status !== 0) fail(`Could not change grants:\n${result.err}`);

  const title = args.on ? 'MAINTENANCE MODE ENABLED — writes stopped' : 'Maintenance mode lifted';

  console.log('');
  console.log(`  ${title}`);
  if (args.reason) console.log(`  Reason: ${args.reason}`);
  console.log('');

  if (args.on) {
    console.log('  The application can still be read. Nothing has been deleted or rolled back.');
    console.log('  Investigate, then lift with: pnpm ops:maintenance --off');
  } else {
    console.log('  Writes are restored. Append-only tables remain append-only.');
  }
  console.log('');

  const alerts = await notify({
    severity: args.on ? 'critical' : 'info',
    title,
    detail: args.reason || undefined,
    environment: process.env.APP_ENV ?? 'development',
    at: new Date().toISOString(),
  });

  for (const alert of alerts) {
    console.log(`  alert ${alert.delivered ? 'delivered' : 'FAILED'}: ${alert.destination}`);
  }
  console.log('');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
