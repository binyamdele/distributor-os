/**
 * Replays every migration against a fresh database and checks the result.
 *
 * The claim this exists to defend is narrow: *a new production database, provisioned from this
 * repository, ends up in the right state.* Nothing else proves it. The development database has
 * accumulated its schema one migration at a time over nine phases, and a migration that only
 * works because of what was already there will pass every test until the day it is run on
 * something empty — which is the day a distributor's system is being set up.
 *
 * It also checks what migrations alone cannot express and what an ORM cannot see:
 *
 *   - Row-Level Security is enabled *and forced* on every business table
 *   - the application role is not a superuser and does not bypass RLS
 *   - the append-only tables have had UPDATE and DELETE revoked
 *   - the immutability triggers exist
 *
 * Those four are the controls the whole tenancy and audit story rests on, and every one of them
 * lives in raw SQL that Prisma's schema does not describe. Without this, "RLS is enforced" would
 * be a property of how one container happened to be provisioned.
 *
 * Usage:
 *   pnpm ops:verify-migrations --container distributor-os-postgres
 */
import { spawnSync } from 'node:child_process';
import { config as loadEnv } from 'dotenv';

loadEnv();

const SCRATCH = 'distributor_os_migration_check';

interface Args {
  container?: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--container' && argv[index + 1]) args.container = argv[index + 1];
    if (argv[index] === '--keep') args.keep = true;
  }
  return args;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function psql(
  container: string,
  user: string,
  password: string,
  database: string,
  sql: string,
): string {
  const result = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      `PGPASSWORD=${password}`,
      container,
      'psql',
      '-U',
      user,
      '-d',
      database,
      '-tAc',
      sql,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) fail(`psql failed:\n${result.stderr}`);
  return (result.stdout ?? '').trim();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.container) fail('Usage: pnpm ops:verify-migrations --container <postgres-container>');

  const url = process.env.DIRECT_URL;
  if (!url) fail('DIRECT_URL must be set.');

  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);

  console.log('\n=== Migration replay ===\n');

  psql(
    args.container,
    user,
    password,
    'postgres',
    `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE);`,
  );
  psql(args.container, user, password, 'postgres', `CREATE DATABASE ${SCRATCH} OWNER ${user};`);

  // The application role's grants come from ALTER DEFAULT PRIVILEGES, which must be in place
  // before the tables are created — exactly as a production database would be provisioned.
  const appRole = new URL(process.env.DATABASE_URL ?? '').username || 'distributor_app';
  psql(
    args.container,
    user,
    password,
    SCRATCH,
    `GRANT USAGE ON SCHEMA public TO ${appRole};
     ALTER DEFAULT PRIVILEGES FOR ROLE ${user} IN SCHEMA public
       GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};
     ALTER DEFAULT PRIVILEGES FOR ROLE ${user} IN SCHEMA public
       GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};`,
  );

  const scratchUrl = new URL(url);
  scratchUrl.pathname = `/${SCRATCH}`;

  console.log(`  Applying every migration to a fresh "${SCRATCH}"…\n`);

  const deploy = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['prisma', 'migrate', 'deploy'],
    {
      encoding: 'utf8',
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        DATABASE_URL: scratchUrl.toString(),
        DIRECT_URL: scratchUrl.toString(),
      },
    },
  );

  if (deploy.status !== 0) {
    fail(`Migrations failed on a fresh database:\n${deploy.stdout}\n${deploy.stderr}`);
  }

  const applied = psql(
    args.container,
    user,
    password,
    SCRATCH,
    `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;`,
  );
  const unfinished = psql(
    args.container,
    user,
    password,
    SCRATCH,
    `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL;`,
  );

  check(`every migration applied (${applied})`, Number(applied) > 0 && Number(unfinished) === 0);

  // --- the controls migrations express in raw SQL ---------------------------
  console.log('');

  const withoutRls = psql(
    args.container,
    user,
    password,
    SCRATCH,
    `SELECT coalesce(string_agg(c.relname, ', '), '')
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND c.relname NOT IN ('_prisma_migrations', 'memberships', 'sessions')
        AND EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_name = c.relname AND column_name = 'organization_id')
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity);`,
  );
  check('RLS enabled and FORCED on every tenant table', withoutRls === '', withoutRls);

  const appIsSuper = psql(
    args.container,
    user,
    password,
    SCRATCH,
    `SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = '${appRole}';`,
  );
  // The single property that makes RLS real rather than decorative: policies do not apply to a
  // superuser, and BYPASSRLS is exactly what it sounds like.
  check(`"${appRole}" is neither superuser nor BYPASSRLS`, appIsSuper === 'f', appIsSuper);

  for (const table of ['audit_events', 'inventory_movements', 'import_jobs']) {
    const writable = psql(
      args.container,
      user,
      password,
      SCRATCH,
      `SELECT coalesce(string_agg(privilege_type, ','), '')
         FROM information_schema.role_table_grants
        WHERE table_name = '${table}' AND grantee = '${appRole}'
          AND privilege_type IN ('UPDATE', 'DELETE');`,
    );
    check(`${table} is append-only for the application role`, writable === '', writable);
  }

  const triggers = psql(
    args.container,
    user,
    password,
    SCRATCH,
    `SELECT coalesce(string_agg(tgname, ', '), '') FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname IN ('payments_confirmed_immutable',
                       'stock_reservations_consumed_immutable',
                       'inventory_discrepancies_resolved_immutable');`,
  );
  check(
    'immutability triggers present',
    triggers.split(', ').filter(Boolean).length === 3,
    triggers,
  );

  const policyCount = psql(
    args.container,
    user,
    password,
    SCRATCH,
    `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation';`,
  );
  check(`tenant_isolation policies present (${policyCount})`, Number(policyCount) > 20);

  if (!args.keep) {
    psql(
      args.container,
      user,
      password,
      'postgres',
      `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE);`,
    );
    console.log('\n  Scratch database dropped.');
  }

  console.log('');
  if (failures === 0) {
    console.log('  MIGRATION REPLAY VERIFIED — a fresh database ends up correctly configured.');
    console.log('');
    process.exit(0);
  }

  console.log(`  MIGRATION REPLAY FAILED — ${failures} check(s) did not pass.`);
  console.log('');
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
