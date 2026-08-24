/**
 * Creates and grants the application's database role, idempotently, against any database.
 *
 * ## The defect this closes
 *
 * These grants used to exist in exactly one place: `docker/init-test-db.sql`, which Postgres runs
 * **once, when the Docker volume is first initialised**. That had two consequences, and the
 * second is the one that matters for a pilot.
 *
 * `pnpm db:reset` drops and recreates schema `public`, which destroys the schema-level grant and
 * the default privileges along with it. The migrations replay, the tables come back — and the
 * application cannot read any of them, because `distributor_app` no longer has `USAGE` on the
 * schema. Every page answers "permission denied for schema public", and the only repair was to
 * destroy the Docker volume so the init script would run again.
 *
 * **And nothing in this repository provisioned the role for a new database at all.** A managed
 * PostgreSQL instance has no `docker-entrypoint-initdb.d`. The role, its grants, and — most
 * easily forgotten — the *default* privileges that cover tables created by future migrations all
 * had to be typed by hand, correctly, from memory. A missed `ALTER DEFAULT PRIVILEGES` is
 * invisible until some later deploy adds a table, and then that one table is unreadable by the
 * application while everything else works.
 *
 * ## What it does
 *
 * Connects as the owner (`DIRECT_URL`) and, safe to re-run at any time:
 *
 *   - creates the role if it does not exist, `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
 *   - grants `CONNECT` on the database and `USAGE` on the schema
 *   - grants table and sequence privileges on what exists now
 *   - sets default privileges so tables from future migrations are covered automatically
 *
 * It deliberately does **not** re-apply the append-only revokes. Those live in the migrations
 * that create those tables, which is where they belong: they are properties of the schema, not of
 * the role. `ops:verify-migrations` and `ops:verify-deployment` both assert they survived.
 *
 * Usage:
 *   pnpm ops:provision-role                    # uses DIRECT_URL, leaves an existing password alone
 *   APP_DB_PASSWORD=… pnpm ops:provision-role  # creates the role, or rotates its password
 */
import { PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

loadEnv();

const ROLE = 'distributor_app';

/**
 * Postgres has no parameter binding for identifiers, and this is executed as the owner — so the
 * one thing that must never happen is a role name arriving from somewhere unexpected. It is a
 * constant above; this refuses anything that is not a plain identifier regardless, because the
 * day someone makes it configurable is the day that reasoning has to still hold.
 */
function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`Refusing to use "${value}" as a SQL identifier.`);
  }
  return value;
}

/** Single-quoted literal for the one place a value cannot be bound: CREATE ROLE … PASSWORD. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error(
      '\nDIRECT_URL must be set. This runs as the database owner, because it grants rights.\n',
    );
    process.exit(1);
  }

  const parsed = new URL(url);
  const database = identifier(decodeURIComponent(parsed.pathname.replace(/^\//, '')));
  // The role that runs migrations owns the tables they create, so it is the role whose default
  // privileges decide what the application can touch afterwards.
  const owner = identifier(decodeURIComponent(parsed.username));
  const role = identifier(ROLE);
  const password = process.env.APP_DB_PASSWORD;

  console.log(`\nProvisioning "${role}" on ${parsed.host}/${database}, as ${owner}.\n`);

  const client = new PrismaClient({ datasources: { db: { url } } });

  try {
    const [existing] = await client.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') AS exists`,
    );

    if (!existing?.exists) {
      if (!password) {
        console.error(
          `The role "${role}" does not exist and APP_DB_PASSWORD is not set.\n` +
            'Set it to the password the application will use, and never to a value that has\n' +
            'appeared in a terminal, a ticket or a commit.\n',
        );
        process.exit(1);
      }
      await client.$executeRawUnsafe(
        `CREATE ROLE ${role} WITH LOGIN PASSWORD ${literal(password)} ` +
          'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
      );
      console.log('  created the role');
    } else if (password) {
      await client.$executeRawUnsafe(`ALTER ROLE ${role} WITH PASSWORD ${literal(password)}`);
      console.log('  rotated the password');
    } else {
      console.log('  role already exists — password left unchanged');
    }

    /*
     * Asserted every run rather than only at creation. These are exactly the attributes that make
     * row-level security real: a superuser ignores every policy, and BYPASSRLS is what it sounds
     * like. If somebody granted them in an emergency and forgot, this takes them back.
     */
    await client.$executeRawUnsafe(
      `ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
    );

    for (const statement of [
      `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
      `GRANT USAGE ON SCHEMA public TO ${role}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      // The line whose absence is invisible until a future migration adds a table.
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public ` +
        `GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    ]) {
      await client.$executeRawUnsafe(statement);
    }
    console.log('  granted connect, schema usage, table and sequence privileges');
    console.log('  set default privileges for tables created by future migrations');

    const [check] = await client.$queryRawUnsafe<
      { schema_usage: boolean; superuser: boolean; bypassrls: boolean }[]
    >(
      `SELECT has_schema_privilege('${role}', 'public', 'USAGE') AS schema_usage,
              r.rolsuper AS superuser, r.rolbypassrls AS bypassrls
         FROM pg_roles r WHERE r.rolname = '${role}'`,
    );

    console.log('');
    console.log(`  schema usage        ${check?.schema_usage ? 'yes' : 'NO'}`);
    console.log(`  superuser           ${check?.superuser ? 'YES — WRONG' : 'no'}`);
    console.log(`  bypasses RLS        ${check?.bypassrls ? 'YES — WRONG' : 'no'}`);
    console.log('');

    if (!check?.schema_usage || check.superuser || check.bypassrls) {
      console.error('Provisioning did not produce the expected role. Stopping.\n');
      process.exit(1);
    }

    console.log('Done. Verify the whole picture with `pnpm ops:verify-deployment`.\n');
  } finally {
    await client.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
