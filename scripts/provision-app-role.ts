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
 *   - creates the role if it does not exist, with LOGIN and every restricted attribute off
 *   - **verifies** the role holds none of the attributes that would void tenancy
 *   - grants `CONNECT` on the database and `USAGE` on the schema
 *   - grants table and sequence privileges on what exists now
 *   - sets default privileges so tables from future migrations are covered automatically
 *
 * It also **re-applies the append-only revokes**, and must. The grant above is
 * `ON ALL TABLES IN SCHEMA public`, which cannot exclude a table — so it hands back the very
 * UPDATE and DELETE rights the migrations took away on the audit trail, the stock ledger and the
 * other write-once tables. An earlier version claimed to leave those alone as "properties of the
 * schema"; in fact it silently destroyed them, and `ops:verify-deployment` caught it:
 *
 *     FAIL  append-only tables cannot be updated or deleted by the app role
 *           — audit_events:UPDATE, audit_events:DELETE, import_jobs:UPDATE, …
 *
 * The revokes stay defined in the migrations that create those tables, which is where they
 * belong. They are repeated here because this script is the only thing that can undo them.
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

/**
 * The role attributes that decide whether tenancy is real.
 *
 * `rolsuper` and `rolbypassrls` matter most: a superuser ignores every RLS policy in the schema,
 * and BYPASSRLS is what it sounds like. The other three are defence in depth — an application
 * role has no business creating databases, creating roles, or streaming replication.
 */
export interface RoleAttributes {
  readonly rolcanlogin: boolean;
  readonly rolsuper: boolean;
  readonly rolbypassrls: boolean;
  readonly rolcreatedb: boolean;
  readonly rolcreaterole: boolean;
  readonly rolreplication: boolean;
}

export interface ProvisionResult {
  readonly sessionRole: string;
  readonly database: string;
  readonly action: 'created' | 'rotated' | 'unchanged';
  readonly attributes: RoleAttributes;
  /** True when a best-effort tightening was attempted and the owner was not allowed to do it. */
  readonly reassertRefused: boolean;
  /** How many append-only revokes were re-applied after the blanket grant. */
  readonly revokesApplied: number;
}

/** Every attribute that must be false, with the reason, for the message when one is not. */
const FORBIDDEN: readonly { key: keyof RoleAttributes; label: string; why: string }[] = [
  { key: 'rolsuper', label: 'SUPERUSER', why: 'ignores every row-level security policy' },
  { key: 'rolbypassrls', label: 'BYPASSRLS', why: 'disables tenant isolation entirely' },
  { key: 'rolcreatedb', label: 'CREATEDB', why: 'no application role needs to create databases' },
  { key: 'rolcreaterole', label: 'CREATEROLE', why: 'no application role needs to create roles' },
  { key: 'rolreplication', label: 'REPLICATION', why: 'no application role needs replication' },
];

/**
 * The subset a managed owner may legally tighten.
 *
 * Postgres requires a true superuser to set SUPERUSER or BYPASSRLS **at all** — including to
 * false — and REPLICATION likewise. CREATEDB and CREATEROLE can be changed by any role holding
 * CREATEROLE, which a managed admin does. So these two are worth *attempting* to correct; the
 * other three can only be reported.
 */
const TIGHTENABLE: readonly (keyof RoleAttributes)[] = ['rolcreatedb', 'rolcreaterole'];

/** Reads the attributes, or null when the role does not exist. */
export async function readRoleAttributes(
  client: SqlClient,
  roleName: string,
): Promise<RoleAttributes | null> {
  const rows = await client.$queryRawUnsafe<RoleAttributes[]>(
    `SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname = ${literal(roleName)}`,
  );
  return rows?.[0] ?? null;
}

/**
 * Fails closed if the role holds any attribute it must not.
 *
 * A *verification*, deliberately, rather than an `ALTER ROLE` asserting the same thing.
 *
 * Postgres requires a true superuser to set SUPERUSER or BYPASSRLS even to false, and a managed
 * provider's admin role is not one — Supabase's `postgres` answers `permission denied to alter
 * role`. The previous version issued that ALTER unconditionally, so on Supabase it created the
 * role and then died one statement later, leaving the database half-provisioned: a role with no
 * grants at all.
 *
 * Depending on a privileged ALTER to *prove* safety means the proof is unavailable on exactly the
 * infrastructure the pilot runs on. Reading `pg_roles` needs no privilege whatsoever and
 * establishes the stronger fact: not "we asked for it to be false" but "it is false".
 */
export function assertRoleIsSafe(roleName: string, attributes: RoleAttributes): void {
  const held = FORBIDDEN.filter((attribute) => attributes[attribute.key]);

  if (held.length > 0) {
    const lines = held.map((a) => `  - ${a.label}: ${a.why}`).join('\n');
    throw new Error(
      `The role ${roleName} holds ${held.length} attribute(s) it must not:\n${lines}\n\n` +
        'Refusing to grant privileges to it — those attributes would make tenant isolation\n' +
        'decorative. Remove them using a role with the authority to do so, which on a managed\n' +
        "provider may mean the provider's own dashboard, then run this again.",
    );
  }

  if (!attributes.rolcanlogin) {
    throw new Error(
      `The role ${roleName} exists but cannot log in, so the application could not use it.`,
    );
  }
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

/**
 * What the migrations take away, and this script must take away again.
 *
 * `GRANT … ON ALL TABLES` has no exclusion list, so it re-opens every one of these. The set is
 * duplicated from the migrations deliberately: those are the source of truth for a *new*
 * database, and this is the only code that can undo them on an existing one. If a future
 * migration adds a write-once table, it belongs here too — `ops:verify-migrations` and
 * `ops:verify-deployment` are what would notice the omission.
 */
const APPEND_ONLY: readonly { table: string; privileges: string }[] = [
  // The audit trail. If this can be edited, it is not an audit trail.
  { table: 'audit_events', privileges: 'UPDATE, DELETE' },
  // The stock ledger: every movement is a fact about goods that physically moved.
  { table: 'inventory_movements', privileges: 'UPDATE, DELETE' },
  { table: 'import_jobs', privileges: 'UPDATE, DELETE' },
  { table: 'ai_interactions', privileges: 'UPDATE, DELETE' },
  { table: 'quotation_approvals', privileges: 'UPDATE, DELETE' },
  // Deletable never: evidence and reservations may be superseded, not erased.
  { table: 'payment_evidence_files', privileges: 'DELETE' },
  { table: 'stock_reservations', privileges: 'DELETE' },
];

/**
 * The revokes, for the append-only tables that actually exist yet.
 *
 * A database that has not been migrated has none of them, and revoking on a missing table is an
 * error rather than a no-op — so the caller passes in what it found.
 */
export function appendOnlyRevokes(roleName: string, existingTables: readonly string[]): string[] {
  const present = new Set(existingTables);
  const role = quoteIdentifier(roleName);

  return APPEND_ONLY.filter((entry) => present.has(entry.table)).map(
    (entry) => `REVOKE ${entry.privileges} ON ${quoteIdentifier(entry.table)} FROM ${role}`,
  );
}

/** Postgres reports a refused ALTER ROLE as SQLSTATE 42501, or says so in the message. */
function isPermissionDenied(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /42501|permission denied|must be superuser|not allowed/i.test(text);
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

  let attributes = await readRoleAttributes(client, ROLE);
  let action: ProvisionResult['action'];

  if (!attributes) {
    if (!options.password) {
      throw new Error(
        `The role ${ROLE} does not exist and APP_DB_PASSWORD is not set.\n` +
          'Set it to the password the application will use, and never to a value that has\n' +
          'appeared in a terminal, a ticket or a commit.',
      );
    }
    /*
     * Every restricted attribute is named on creation. This works even for a managed owner:
     * naming the *absence* of SUPERUSER is the default and needs no privilege, whereas altering
     * it afterwards does. Creation is the one moment these can be stated cheaply, so they are.
     */
    await client.$executeRawUnsafe(
      `CREATE ROLE ${role} WITH LOGIN PASSWORD ${literal(options.password)} ` +
        'NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION',
    );
    action = 'created';
    log('  created the role');
  } else if (options.password) {
    /*
     * Not best-effort. If an operator asked to rotate a credential, silently not rotating it is
     * the one outcome that must never be reported as success — they would believe the old
     * password is dead when it is still live.
     */
    await client.$executeRawUnsafe(`ALTER ROLE ${role} WITH PASSWORD ${literal(options.password)}`);
    action = 'rotated';
    log('  rotated the password');
  } else {
    action = 'unchanged';
    log('  role already exists — password left unchanged');
  }

  attributes = await readRoleAttributes(client, ROLE);
  if (!attributes) {
    throw new Error(`The role ${ROLE} could not be read back after provisioning it.`);
  }

  /*
   * Best-effort tightening of the two attributes a managed owner may legally change.
   *
   * Attempted only when one is actually set, so the common path issues no privileged statement
   * at all. A refusal is reported and does not stop the run — the verification below is what
   * decides, and it does not care how the attribute came to be false.
   */
  let reassertRefused = false;
  const tightenable = TIGHTENABLE.filter((key) => attributes![key]);

  if (tightenable.length > 0) {
    try {
      await client.$executeRawUnsafe(`ALTER ROLE ${role} NOCREATEDB NOCREATEROLE`);
      log('  tightened CREATEDB/CREATEROLE');
      attributes = (await readRoleAttributes(client, ROLE)) ?? attributes;
    } catch (error) {
      if (!isPermissionDenied(error)) throw error;
      reassertRefused = true;
      log('  could not tighten CREATEDB/CREATEROLE — this owner may not alter roles');
    }
  }

  /*
   * The security invariant, established by reading rather than by asserting. Nothing is granted
   * until this passes.
   */
  assertRoleIsSafe(ROLE, attributes);
  log('  verified: no SUPERUSER, BYPASSRLS, CREATEDB, CREATEROLE or REPLICATION');

  for (const statement of provisionStatements({ role: ROLE, owner, database })) {
    await client.$executeRawUnsafe(statement);
  }
  log('  granted connect, schema usage, table and sequence privileges');
  log('  set default privileges for tables created by future migrations');

  /*
   * Immediately after the grants, and never before them: the blanket
   * `GRANT … ON ALL TABLES` above has just handed back UPDATE and DELETE on the write-once
   * tables, so this is what puts them back the way the migrations left them.
   */
  const tables = await client.$queryRawUnsafe<{ tablename: string }[]>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  const revokes = appendOnlyRevokes(
    ROLE,
    (tables ?? []).map((row) => row.tablename),
  );

  for (const statement of revokes) {
    await client.$executeRawUnsafe(statement);
  }
  log(`  re-revoked write access on ${revokes.length} append-only table(s)`);

  const [check] = await client.$queryRawUnsafe<{ schema_usage: boolean }[]>(
    `SELECT has_schema_privilege(${literal(ROLE)}, 'public', 'USAGE') AS schema_usage`,
  );

  log('');
  log(`  schema usage        ${check?.schema_usage ? 'yes' : 'NO'}`);
  log(`  superuser           ${attributes.rolsuper ? 'YES — WRONG' : 'no'}`);
  log(`  bypasses RLS        ${attributes.rolbypassrls ? 'YES — WRONG' : 'no'}`);
  log(
    `  createdb/createrole ${attributes.rolcreatedb || attributes.rolcreaterole ? 'YES — WRONG' : 'no'}`,
  );
  log(`  replication         ${attributes.rolreplication ? 'YES — WRONG' : 'no'}`);
  log('');

  if (!check?.schema_usage) {
    throw new Error(
      `Granting completed but ${ROLE} still has no USAGE on schema public. Stopping.`,
    );
  }

  return { sessionRole: owner, database, action, attributes, reassertRefused, revokesApplied: revokes.length };
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
   * Nothing taken from it reaches a SQL statement.
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
    const result = await provision(client, { password: process.env.APP_DB_PASSWORD });
    if (result.reassertRefused) {
      console.log('This owner cannot alter role attributes, so they were verified instead.');
    }
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
