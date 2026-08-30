import { describe, expect, it } from 'vitest';
import {
  literal,
  provision,
  provisionStatements,
  quoteIdentifier,
  type SqlClient,
} from '../../scripts/provision-app-role';

/**
 * Provisioning the application role against a managed database.
 *
 * The role this script creates is what makes row-level security real, so the script has to work
 * on the infrastructure the pilot actually runs on — not only on a local Postgres container where
 * the connection username happens to be a role name.
 */

/**
 * A Supabase shared-pooler username: a routing label, not a role.
 *
 * The project reference here is invented. The real one belongs to a real project and has no place
 * in a test fixture, a commit, or anything a scanner reads.
 */
const POOLER_USERNAME = 'postgres.examplerefid';

/** What `current_user` actually returns once such a connection lands. */
const SESSION_ROLE = 'postgres';

interface FakeClientOptions {
  sessionRole?: string;
  databaseName?: string;
  roleExists?: boolean;
}

/** Records every statement executed, and answers the three queries the script asks. */
function fakeClient(options: FakeClientOptions = {}) {
  const executed: string[] = [];
  const queried: string[] = [];

  const client: SqlClient = {
    async $queryRawUnsafe<T>(sql: string): Promise<T> {
      queried.push(sql);

      if (sql.includes('current_user')) {
        return [
          {
            session_role: options.sessionRole ?? SESSION_ROLE,
            database_name: options.databaseName ?? 'postgres',
          },
        ] as T;
      }
      if (sql.includes('pg_roles WHERE rolname')) {
        return [{ exists: options.roleExists ?? true }] as T;
      }
      // The final verification.
      return [{ schema_usage: true, superuser: false, bypassrls: false }] as T;
    },
    async $executeRawUnsafe(sql: string): Promise<unknown> {
      executed.push(sql);
      return 0;
    },
  };

  return { client, executed, queried };
}

const silently = { log: () => {} };

describe('quoting an identifier', () => {
  it('quotes a plain role name', () => {
    expect(quoteIdentifier('distributor_app')).toBe('"distributor_app"');
  });

  it('accepts names an allowlist would have refused', () => {
    /*
     * A dot, a hyphen and a capital are all legal inside a quoted identifier. The previous
     * validator rejected them, which is what broke against Supabase — and the safety never came
     * from the allowlist, because nothing was quoted.
     */
    expect(quoteIdentifier('postgres.examplerefid')).toBe('"postgres.examplerefid"');
    expect(quoteIdentifier('distributor-os')).toBe('"distributor-os"');
    expect(quoteIdentifier('MixedCase')).toBe('"MixedCase"');
  });

  it('refuses anything that could break out of the quoting', () => {
    // A double quote would close the identifier early; everything after it would be SQL.
    expect(() => quoteIdentifier('role"; DROP TABLE users; --')).toThrow(/quote or control/);
    expect(() => quoteIdentifier('a"b')).toThrow(/quote or control/);
  });

  it('refuses control characters, which no real name contains', () => {
    expect(() => quoteIdentifier(`role${String.fromCharCode(0)}`)).toThrow(/quote or control/);
    expect(() => quoteIdentifier(`role${String.fromCharCode(10)}`)).toThrow(/quote or control/);
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
  it('quotes every identifier', () => {
    const statements = provisionStatements({
      role: 'distributor_app',
      owner: 'postgres',
      database: 'postgres',
    });

    expect(statements).toContain('GRANT CONNECT ON DATABASE "postgres" TO "distributor_app"');
    expect(statements).toContain('GRANT USAGE ON SCHEMA public TO "distributor_app"');
    expect(
      statements.some((s) => s.startsWith('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres"')),
    ).toBe(true);
  });

  it('covers tables created by future migrations, in both directions', () => {
    // The grant whose absence is invisible until some later deploy adds a table.
    const statements = provisionStatements({
      role: 'distributor_app',
      owner: 'postgres',
      database: 'postgres',
    });

    const defaults = statements.filter((s) => s.includes('ALTER DEFAULT PRIVILEGES'));
    expect(defaults).toHaveLength(2);
    expect(defaults.some((s) => s.includes('ON TABLES TO "distributor_app"'))).toBe(true);
    expect(defaults.some((s) => s.includes('ON SEQUENCES TO "distributor_app"'))).toBe(true);
  });
});

describe('against a Supabase shared pooler', () => {
  it('takes the owner from the database, never from the connection username', async () => {
    /*
     * The regression. `DIRECT_URL` carries `postgres.<projectref>`; the script used to feed that
     * to the identifier validator and die before running anything. Loosening the validator would
     * have been worse than the crash: the default-privilege grants would have named a role that
     * does not exist, applied to nothing, and reported success.
     */
    const { client, executed } = fakeClient({ sessionRole: SESSION_ROLE });

    const result = await provision(client, silently);

    expect(result.sessionRole).toBe(SESSION_ROLE);

    const sql = executed.join('\n');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "postgres"');
    // The routing label must not reach a statement, in any form.
    expect(sql).not.toContain(POOLER_USERNAME);
    expect(sql).not.toContain('examplerefid');
  });

  it('asks the database for its own name rather than trusting the URL path', async () => {
    const { client, executed } = fakeClient({ databaseName: 'postgres' });

    await provision(client, silently);

    expect(executed.some((s) => s.includes('GRANT CONNECT ON DATABASE "postgres"'))).toBe(true);
  });

  it('reports the session role it resolved, so an operator can see it', async () => {
    const lines: string[] = [];
    const { client } = fakeClient({ sessionRole: SESSION_ROLE, databaseName: 'postgres' });

    await provision(client, { log: (line) => lines.push(line) });

    expect(lines.join('\n')).toContain('connected as "postgres" on database "postgres"');
  });
});

describe('the role attributes that make RLS real', () => {
  it('re-asserts every one of them on an existing role', async () => {
    const { client, executed } = fakeClient({ roleExists: true });

    const result = await provision(client, silently);

    expect(result.action).toBe('unchanged');

    const alter = executed.find(
      (s) => s.startsWith('ALTER ROLE') && !s.includes('PASSWORD'),
    );
    expect(alter).toBeDefined();
    // A superuser ignores every policy, and BYPASSRLS is what it sounds like.
    for (const attribute of [
      'NOSUPERUSER',
      'NOBYPASSRLS',
      'NOCREATEDB',
      'NOCREATEROLE',
      'NOREPLICATION',
    ]) {
      expect(alter).toContain(attribute);
    }
  });

  it('creates the role with the same attributes when it is missing', async () => {
    const { client, executed } = fakeClient({ roleExists: false });

    const result = await provision(client, { ...silently, password: 'a-test-only-password' });

    expect(result.action).toBe('created');
    const create = executed.find((s) => s.startsWith('CREATE ROLE'));
    expect(create).toContain('"distributor_app"');
    expect(create).toContain('NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION');
  });

  it('refuses to invent a password for a role that does not exist', async () => {
    const { client } = fakeClient({ roleExists: false });

    await expect(provision(client, silently)).rejects.toThrow(/APP_DB_PASSWORD is not set/);
  });

  it('rotates the password only when one is supplied', async () => {
    const { client, executed } = fakeClient({ roleExists: true });

    const result = await provision(client, { ...silently, password: 'another-test-password' });

    expect(result.action).toBe('rotated');
    expect(executed.some((s) => s.includes('ALTER ROLE "distributor_app" WITH PASSWORD'))).toBe(
      true,
    );
  });

  it('fails loudly if the finished role is not what was asked for', async () => {
    const { client } = fakeClient();
    // A client that reports the role as a superuser afterwards.
    const wrong: SqlClient = {
      ...client,
      async $queryRawUnsafe<T>(sql: string): Promise<T> {
        if (sql.includes('current_user')) {
          return [{ session_role: 'postgres', database_name: 'postgres' }] as T;
        }
        if (sql.includes('pg_roles WHERE rolname')) return [{ exists: true }] as T;
        return [{ schema_usage: true, superuser: true, bypassrls: false }] as T;
      },
    };

    await expect(provision(wrong, silently)).rejects.toThrow(/did not produce the expected role/);
  });
});
