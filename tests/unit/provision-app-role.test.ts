import { describe, expect, it } from 'vitest';
import {
  assertRoleIsSafe,
  literal,
  provision,
  provisionStatements,
  quoteIdentifier,
  type RoleAttributes,
  type SqlClient,
} from '../../scripts/provision-app-role';

/**
 * Provisioning the application role against a managed database.
 *
 * The role this script creates is what makes row-level security real, so the script has to work
 * on the infrastructure the pilot actually runs on — not only on a local Postgres container where
 * the connecting role is a true superuser and the connection username is a role name.
 */

/**
 * A Supabase shared-pooler username: a routing label, not a role.
 *
 * The project reference is invented. The real one belongs to a real project and has no place in a
 * test fixture, a commit, or anything a scanner reads.
 */
const POOLER_USERNAME = 'postgres.examplerefid';

/** What `current_user` actually returns once such a connection lands. */
const SESSION_ROLE = 'postgres';

const SAFE: RoleAttributes = {
  rolcanlogin: true,
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
};

interface FakeOptions {
  sessionRole?: string;
  databaseName?: string;
  /** null means the role does not exist yet. A list is consumed one read at a time. */
  attributes?: RoleAttributes | null | (RoleAttributes | null)[];
  /** Simulates a managed owner: ALTER ROLE is refused. */
  refuseAlterRole?: boolean;
  schemaUsage?: boolean;
}

function fakeClient(options: FakeOptions = {}) {
  const executed: string[] = [];
  const reads: (RoleAttributes | null)[] = Array.isArray(options.attributes)
    ? [...options.attributes]
    : [options.attributes === undefined ? SAFE : options.attributes];

  const client: SqlClient = {
    async $queryRawUnsafe<T>(sql: string): Promise<T> {
      if (sql.includes('current_user')) {
        return [
          {
            session_role: options.sessionRole ?? SESSION_ROLE,
            database_name: options.databaseName ?? 'postgres',
          },
        ] as T;
      }
      if (sql.includes('FROM pg_roles')) {
        // Repeat the last answer once the script reads more times than the test scripted.
        const next = reads.length > 1 ? reads.shift() : reads[0];
        return (next ? [next] : []) as T;
      }
      return [{ schema_usage: options.schemaUsage ?? true }] as T;
    },
    async $executeRawUnsafe(sql: string): Promise<unknown> {
      if (options.refuseAlterRole && /^ALTER ROLE/.test(sql) && !/WITH PASSWORD/.test(sql)) {
        throw new Error(
          'permission denied to alter role\nDETAIL: Only roles with the SUPERUSER attribute ' +
            'may alter roles with the SUPERUSER attribute.',
        );
      }
      executed.push(sql);
      return 0;
    },
  };

  return { client, executed };
}

const silently = { log: () => {} };

describe('quoting an identifier', () => {
  it('quotes a plain role name', () => {
    expect(quoteIdentifier('distributor_app')).toBe('"distributor_app"');
  });

  it('accepts names an allowlist would have refused', () => {
    expect(quoteIdentifier('postgres.examplerefid')).toBe('"postgres.examplerefid"');
    expect(quoteIdentifier('distributor-os')).toBe('"distributor-os"');
    expect(quoteIdentifier('MixedCase')).toBe('"MixedCase"');
  });

  it('refuses anything that could break out of the quoting', () => {
    expect(() => quoteIdentifier('role"; DROP TABLE users; --')).toThrow(/quote or control/);
    expect(() => quoteIdentifier(`role${String.fromCharCode(0)}`)).toThrow(/quote or control/);
    expect(() => quoteIdentifier(`role${String.fromCharCode(127)}`)).toThrow(/quote or control/);
  });

  it('refuses the empty string and anything past Postgres’s length limit', () => {
    expect(() => quoteIdentifier('')).toThrow(/empty/);
    expect(() => quoteIdentifier('a'.repeat(64))).toThrow(/over-long/);
    expect(quoteIdentifier('a'.repeat(63))).toBe(`"${'a'.repeat(63)}"`);
  });

  it('escapes a quote in a literal, which is a different job', () => {
    expect(literal("O'Brien")).toBe("'O''Brien'");
  });
});

describe('the statements it builds', () => {
  it('quotes every identifier and covers future migrations both ways', () => {
    const statements = provisionStatements({
      role: 'distributor_app',
      owner: 'postgres',
      database: 'postgres',
    });

    expect(statements).toContain('GRANT CONNECT ON DATABASE "postgres" TO "distributor_app"');
    expect(statements).toContain('GRANT USAGE ON SCHEMA public TO "distributor_app"');

    const defaults = statements.filter((s) => s.includes('ALTER DEFAULT PRIVILEGES'));
    expect(defaults).toHaveLength(2);
    expect(defaults.every((s) => s.includes('FOR ROLE "postgres"'))).toBe(true);
    expect(defaults.some((s) => s.includes('ON TABLES TO "distributor_app"'))).toBe(true);
    expect(defaults.some((s) => s.includes('ON SEQUENCES TO "distributor_app"'))).toBe(true);
  });
});

describe('verifying the role rather than asserting it', () => {
  it('accepts a role with every restricted attribute off', () => {
    expect(() => assertRoleIsSafe('distributor_app', SAFE)).not.toThrow();
  });

  it.each([
    ['rolsuper', 'SUPERUSER'],
    ['rolbypassrls', 'BYPASSRLS'],
    ['rolcreatedb', 'CREATEDB'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolreplication', 'REPLICATION'],
  ] as const)('fails closed when %s is set', (key, label) => {
    expect(() => assertRoleIsSafe('distributor_app', { ...SAFE, [key]: true })).toThrow(
      new RegExp(label),
    );
  });

  it('names every offending attribute at once, not just the first', () => {
    expect(() =>
      assertRoleIsSafe('distributor_app', { ...SAFE, rolsuper: true, rolbypassrls: true }),
    ).toThrow(/2 attribute/);
  });

  it('refuses a role that cannot log in, which the application could not use', () => {
    expect(() => assertRoleIsSafe('distributor_app', { ...SAFE, rolcanlogin: false })).toThrow(
      /cannot log in/,
    );
  });
});

describe('against a Supabase shared pooler', () => {
  it('takes the owner from the database, never from the connection username', async () => {
    const { client, executed } = fakeClient();

    const result = await provision(client, silently);

    expect(result.sessionRole).toBe(SESSION_ROLE);
    const sql = executed.join('\n');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres"');
    expect(sql).not.toContain(POOLER_USERNAME);
    expect(sql).not.toContain('examplerefid');
  });

  it('asks the database for its own name rather than trusting the URL path', async () => {
    const { client, executed } = fakeClient({ databaseName: 'postgres' });
    await provision(client, silently);
    expect(executed.some((s) => s.includes('GRANT CONNECT ON DATABASE "postgres"'))).toBe(true);
  });
});

describe('a managed owner that can create a role but not alter its attributes', () => {
  it('creates the role with every restricted attribute named, and never alters them', async () => {
    /*
     * The regression. Supabase's `postgres` has admin capability but is not a true superuser, and
     * Postgres requires one to set SUPERUSER or BYPASSRLS *even to false*. The previous version
     * issued `ALTER ROLE … NOSUPERUSER NOBYPASSRLS …` unconditionally, so it created the role and
     * then died on the next statement — leaving a role with no grants at all.
     */
    const { client, executed } = fakeClient({
      attributes: [null, SAFE],
      refuseAlterRole: true,
    });

    const result = await provision(client, { ...silently, password: 'a-test-only-password' });

    expect(result.action).toBe('created');

    const create = executed.find((s) => s.startsWith('CREATE ROLE'));
    expect(create).toContain('LOGIN');
    expect(create).toContain('NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');

    // Nothing tried to alter the restricted attributes afterwards.
    const alters = executed.filter((s) => /^ALTER ROLE/.test(s) && !/WITH PASSWORD/.test(s));
    expect(alters).toHaveLength(0);

    // And it went on to do the thing it exists for.
    expect(executed.some((s) => s.startsWith('GRANT USAGE ON SCHEMA public'))).toBe(true);
  });

  it('proceeds to the grants when a safe role already exists', async () => {
    /*
     * The state the Supabase database is actually in: the role was created, then the run died
     * before any grant. Re-running must pick up from there rather than needing the role dropped.
     */
    const { client, executed } = fakeClient({ attributes: SAFE, refuseAlterRole: true });

    const result = await provision(client, silently);

    expect(result.action).toBe('unchanged');
    expect(executed.filter((s) => s.startsWith('GRANT'))).toHaveLength(4);
    expect(executed.filter((s) => s.startsWith('ALTER DEFAULT PRIVILEGES'))).toHaveLength(2);
  });

  it('tightens CREATEDB when the owner is allowed to, then proceeds', async () => {
    /*
     * CREATEDB and CREATEROLE are the two a CREATEROLE owner may legally change — unlike
     * SUPERUSER, BYPASSRLS and REPLICATION, which need a true superuser even to switch off. So
     * they are worth attempting, and this is the path where the attempt works.
     */
    const withCreatedb = { ...SAFE, rolcreatedb: true };
    const { client, executed } = fakeClient({
      attributes: [withCreatedb, withCreatedb, SAFE],
    });

    const result = await provision(client, silently);

    expect(executed).toContain('ALTER ROLE "distributor_app" NOCREATEDB NOCREATEROLE');
    expect(result.reassertRefused).toBe(false);
    expect(result.attributes.rolcreatedb).toBe(false);
    // Having corrected it, the run does what it exists for.
    expect(executed.some((s) => s.startsWith('GRANT USAGE ON SCHEMA public'))).toBe(true);
  });

  it('attempts no tightening at all when nothing needs it', async () => {
    // The common path issues no privileged statement, so a managed owner never sees a refusal.
    const { client, executed } = fakeClient({ attributes: SAFE, refuseAlterRole: true });

    const result = await provision(client, silently);

    expect(executed.some((s) => /^ALTER ROLE/.test(s))).toBe(false);
    expect(result.reassertRefused).toBe(false);
  });

  it('still fails closed when a refused tightening leaves the attribute set', async () => {
    const unsafe = { ...SAFE, rolcreaterole: true };
    const { client, executed } = fakeClient({
      attributes: [unsafe, unsafe],
      refuseAlterRole: true,
    });

    await expect(provision(client, silently)).rejects.toThrow(/CREATEROLE/);
    // Nothing was granted to it.
    expect(executed.filter((s) => s.startsWith('GRANT'))).toHaveLength(0);
  });
});

describe('an unsafe existing role', () => {
  it('fails closed on SUPERUSER and grants nothing', async () => {
    const superuser = { ...SAFE, rolsuper: true };
    const { client, executed } = fakeClient({ attributes: [superuser, superuser] });

    await expect(provision(client, silently)).rejects.toThrow(/SUPERUSER/);
    expect(executed.filter((s) => s.startsWith('GRANT'))).toHaveLength(0);
    expect(executed.filter((s) => s.startsWith('ALTER DEFAULT PRIVILEGES'))).toHaveLength(0);
  });

  it('fails closed on BYPASSRLS and grants nothing', async () => {
    const bypass = { ...SAFE, rolbypassrls: true };
    const { client, executed } = fakeClient({ attributes: [bypass, bypass] });

    await expect(provision(client, silently)).rejects.toThrow(/BYPASSRLS/);
    expect(executed.filter((s) => s.startsWith('GRANT'))).toHaveLength(0);
  });
});

describe('passwords', () => {
  it('rotates an existing role’s password when one is supplied', async () => {
    const { client, executed } = fakeClient({ attributes: SAFE });

    const result = await provision(client, { ...silently, password: 'another-test-password' });

    expect(result.action).toBe('rotated');
    expect(executed.some((s) => s.includes('ALTER ROLE "distributor_app" WITH PASSWORD'))).toBe(
      true,
    );
  });

  it('leaves the password alone when none is supplied', async () => {
    const { client, executed } = fakeClient({ attributes: SAFE });

    const result = await provision(client, silently);

    expect(result.action).toBe('unchanged');
    expect(executed.some((s) => s.includes('WITH PASSWORD'))).toBe(false);
  });

  it('refuses to invent a password for a role that does not exist', async () => {
    const { client } = fakeClient({ attributes: null });
    await expect(provision(client, silently)).rejects.toThrow(/APP_DB_PASSWORD is not set/);
  });
});

describe('the final check', () => {
  it('fails if the role still has no schema usage after granting', async () => {
    const { client } = fakeClient({ attributes: SAFE, schemaUsage: false });
    await expect(provision(client, silently)).rejects.toThrow(/no USAGE on schema public/);
  });
});
