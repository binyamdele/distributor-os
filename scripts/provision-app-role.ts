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

/** Postgres truncates identifiers at NAMEDATALEN - 1. */
const MAX_IDENTIFIER_BYTES = 63;

/**
 * Is this character one that could break out of, or corrupt, a double-quoted identifier?
 *
 * A double quote would end the quoting early; a NUL terminates the string as far as libpq is
 * concerned; the other C0 controls and DEL have no business in a role or database name and are a
 * reliable sign that something upstream is wrong. Written as code-point comparisons rather than a
 * regex so the source carries no literal control characters of its own.
 */
function isUnsafeInIdentifier(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return char === '"' || code < 0x20 || code === 0x7f;
}

/**
 * Validates an identifier, then quotes it.
 *
 * Postgres has no parameter binding for identifiers, so the only safe way to interpolate one is
 * to reject what cannot be quoted and then quote it. Everything that survives the check is
 * wrapped in double quotes and is therefore inert.
 *
 * This replaces a `^[a-z_][a-z0-9_]*$` allowlist, and it is a strengthening rather than a
 * loosening. The allowlist could not express a legitimate name containing a dot, a hyphen or a
 * capital — while still depending on the *absence* of quoting for its safety, since it never
 * quoted anything. This depends on the quoting, which is what actually makes a value inert.
 */
export function quoteIdentifier(value: string): string {
  if (value.length === 0) {
    throw new Error('Refusing to use an empty string as a SQL identifier.');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new Error('Refusing to use an over-long value as a SQL identifier.');
  }
  for (const char of value) {
    if (isUnsafeInIdentifier(char)) {
      throw new Error('Refusing to use a value containing a quote or control character.');
    }
  }
  return `"${value}"`;
}

/** Single-quoted literal for the one place a value cannot be bound: CREATE ROLE … PASSWORD. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Just enough of a Prisma client to run this, so it can be exercised without a database. */
export interface SqlClient {
  $queryRawUnsafe<T = unknown>(sql: string): Promise<T>;
  $executeRawUnsafe(sql: string): Promise<unknown>;
}

export interface ProvisionResult {
  readonly sessionRole: string;
  readonly database: string;
  readonly action: 'created' | 'rotated' | 'unchanged';
}

/**
 * The grants, in the order they are applied.
 *
 * Split out so the statements can be inspected without a database. `owner` is the role whose
 * *future* tables the default privileges cover; every identifier is quoted the same way.
 */
export function provisionStatements(options: {
  role: string;
  owner: string;
  database: string;
}): string[] {
  const role = quoteIdentifier(options.role);
  const owner = quoteIdentifier(options.owner);
  const database = quoteIdentifier(options.database);

  return [
    `GRANT CONNECT ON DATABASE ${database} TO ${role}`,
    `GRANT USAGE ON SCHEMA public TO ${role}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
    // The line whose absence is invisible until a future migration adds a table.
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public ` +
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public ` +
      `GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
  ];
}

export async function provision(
  client: SqlClient,
  options: { password?: string; log?: (line: string) => void } = {},
): Promise<ProvisionResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const role = quoteIdentifier(ROLE);

  /*
   * Ask the database who we are, rather than reading it off the connection string.
   *
   * A URL's username is a *connection* credential, and on a managed provider it is not even that.
   * Supabase's shared pooler expects `postgres.<projectref>`: a routing label that tells the
   * pooler which project to connect to, and not the name of any role in the database it lands
   * in. Deriving the owner from it failed before a single statement ran —
   * `Refusing to use "postgres.<projectref>" as a SQL identifier.`
   *
   * Worse than that crash is the version of this bug that would not have crashed. Had the
   * validator simply been loosened to accept a dot, the script would have issued
   * `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres.<projectref>"` naming a role that does not
   * exist — and the grant that matters most, the one covering tables from future migrations,
   * would have applied to nothing at all while the script printed success.
   *
   * `current_user` is the role the session actually runs as, so it is the role that will own the
   * tables migrations create. That ownership is the only thing default privileges can key off.
   */
  const [session] = await client.$queryRawUnsafe<{ session_role: string; database_name: string }[]>(
    'SELECT current_user AS session_role, current_database() AS database_name',
  );

  if (!session?.session_role || !session?.database_name) {
    throw new Error('Could not determine the session role and database from the connection.');
  }

  const owner = session.session_role;
  const database = session.database_name;

  log(`  connected as "${owner}" on database "${database}"`);

  const [existing] = await client.$queryRawUnsafe<{ exists: boolean }[]>(
    `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(ROLE)}) AS exists`,
  );

  let action: ProvisionResult['action'];

  if (!existing?.exists) {
    if (!options.password) {
      throw new Error(
        `The role ${ROLE} does not exist and APP_DB_PASSWORD is not set.\n` +
          'Set it to the password the application will use, and never to a value that has\n' +
          'appeared in a terminal, a ticket or a commit.',
      );
    }
    await client.$executeRawUnsafe(
      `CREATE ROLE ${role} WITH LOGIN PASSWORD ${literal(options.password)} ` +
        'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
    );
    action = 'created';
    log('  created the role');
  } else if (options.password) {
    await client.$executeRawUnsafe(`ALTER ROLE ${role} WITH PASSWORD ${literal(options.password)}`);
    action = 'rotated';
    log('  rotated the password');
  } else {
    action = 'unchanged';
    log('  role already exists — password left unchanged');
  }

  /*
   * Asserted every run rather than only at creation. These are exactly the attributes that make
   * row-level security real: a superuser ignores every policy, and BYPASSRLS is what it sounds
   * like. If somebody granted them in an emergency and forgot, this takes them back.
   */
  await client.$executeRawUnsafe(
    `ALTER ROLE ${role} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`,
  );

  for (const statement of provisionStatements({ role: ROLE, owner, database })) {
    await client.$executeRawUnsafe(statement);
  }
  log('  granted connect, schema usage, table and sequence privileges');
  log('  set default privileges for tables created by future migrations');

  const [check] = await client.$queryRawUnsafe<
    { schema_usage: boolean; superuser: boolean; bypassrls: boolean }[]
  >(
    `SELECT has_schema_privilege(${literal(ROLE)}, 'public', 'USAGE') AS schema_usage,
            r.rolsuper AS superuser, r.rolbypassrls AS bypassrls
       FROM pg_roles r WHERE r.rolname = ${literal(ROLE)}`,
  );

  log('');
  log(`  schema usage        ${check?.schema_usage ? 'yes' : 'NO'}`);
  log(`  superuser           ${check?.superuser ? 'YES — WRONG' : 'no'}`);
  log(`  bypasses RLS        ${check?.bypassrls ? 'YES — WRONG' : 'no'}`);
  log('');

  if (!check?.schema_usage || check.superuser || check.bypassrls) {
    throw new Error('Provisioning did not produce the expected role.');
  }

  return { sessionRole: owner, database, action };
}

async function main(): Promise<void> {
  const url = process.env.DIRECT_URL;
  if (!url) {
    console.error(
      '\nDIRECT_URL must be set. This runs as the database owner, because it grants rights.\n',
    );
    process.exit(1);
  }

  /*
   * The URL is parsed for one thing only: telling the operator which host they are pointed at.
   * Nothing taken from it reaches a SQL statement — that is the whole point of the fix above.
   */
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'an unparseable host';
    }
  })();

  console.log(`\nProvisioning "${ROLE}" on ${host}.\n`);

  const client = new PrismaClient({ datasources: { db: { url } } });

  try {
    await provision(client, { password: process.env.APP_DB_PASSWORD });
    console.log('Done. Verify the whole picture with `pnpm ops:verify-deployment`.\n');
  } finally {
    await client.$disconnect();
  }
}

// Only when invoked directly, so the functions above can be imported by tests.
if (process.argv[1]?.includes('provision-app-role')) {
  main().catch((error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
