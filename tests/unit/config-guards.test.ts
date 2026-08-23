import { describe, expect, it } from 'vitest';
import { destructiveOperationsAllowed, parseConfig } from '@/platform/config';
import { assessGuard, looksLikeProductionDatabase } from '../../prisma/guard';
import { consume, reset } from '@/platform/observability/rate-limit';

/**
 * The production guards.
 *
 * Phase 9's assessment put "the demo seed can be run against production" at the top of the
 * blocker list. These are the tests that make the refusal a property rather than an intention —
 * because the failure mode is not an error message, it is a distributor's real records replaced
 * by fabricated ones, and nobody gets a second attempt at noticing.
 */

const base = {
  DATABASE_URL: 'postgresql://app:pw@db.example.com:5432/prod',
  SESSION_SECRET: 'Zx9Kq2mTrv7BnLdWpAeJhYcUgSf4NiRoQ3XbMzVt',
  APP_URL: 'https://pilot.example.com',
  BUILD_SHA: 'abc1234',
  AI_PROVIDER: 'anthropic',
  ANTHROPIC_API_KEY: 'sk-test',
  FILE_STORAGE_DRIVER: 's3',
  S3_BUCKET: 'evidence',
  S3_REGION: 'eu-west-1',
  S3_ACCESS_KEY_ID: 'AKIA',
  S3_SECRET_ACCESS_KEY: 'secret',
} as const;

const production = (overrides: Record<string, string> = {}) =>
  parseConfig({ ...base, APP_ENV: 'production', ...overrides } as unknown as NodeJS.ProcessEnv);

function problemsOf(result: ReturnType<typeof parseConfig>): string {
  return result.ok ? '' : result.problems.join('\n');
}

describe('a valid production configuration', () => {
  it('parses', () => {
    const result = production();
    expect(problemsOf(result)).toBe('');
    expect(result.ok).toBe(true);
  });

  it('defaults the pool to something a managed database will tolerate', () => {
    const result = production();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Small on purpose: a container that opens more than its share of a capped plan starves the
    // migration job and any admin session trying to diagnose the problem.
    expect(result.value.DATABASE_POOL_SIZE).toBeLessThanOrEqual(10);
  });
});

describe('production refuses what would mislead or lose data', () => {
  it('refuses the mock AI provider', () => {
    // A rule-based stub behind screens that imply a model read the customer's message. The
    // distributor would believe an interpretation nothing performed.
    const result = production({ AI_PROVIDER: 'mock', ANTHROPIC_API_KEY: '' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('AI_PROVIDER');
    expect(problemsOf(result)).toContain('disabled');
  });

  it('permits "disabled", which is the honest way to run without a provider', () => {
    const result = production({ AI_PROVIDER: 'disabled', ANTHROPIC_API_KEY: '' });
    expect(result.ok).toBe(true);
  });

  it('permits the mock only under an explicit demo flag', () => {
    const result = production({ AI_PROVIDER: 'mock', ANTHROPIC_API_KEY: '', DEMO_MODE: 'true' });
    expect(result.ok).toBe(true);
  });

  it('refuses local file storage', () => {
    // Container filesystems are ephemeral. Evidence written there vanishes on restart, leaving
    // payment rows pointing at bank slips that no longer exist.
    const result = production({ FILE_STORAGE_DRIVER: 'local' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('ephemeral');
  });

  it('refuses anthropic without a key', () => {
    const result = production({ ANTHROPIC_API_KEY: '' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('ANTHROPIC_API_KEY');
  });

  it('refuses a plain-HTTP application URL', () => {
    const result = production({ APP_URL: 'http://pilot.example.com' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('https');
  });

  it('refuses a missing application URL', () => {
    const result = parseConfig({
      ...base,
      APP_ENV: 'production',
      APP_URL: undefined,
    } as unknown as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
  });

  it('refuses a placeholder session secret', () => {
    // Padded to pass the length check, so this is testing the placeholder detection rather than
    // the length one.
    const result = production({ SESSION_SECRET: 'change-me'.padEnd(40, '-') });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toMatch(/placeholder|entropy/);
  });

  it('refuses a secret somebody produced by holding down a key', () => {
    const result = production({ SESSION_SECRET: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('entropy');
  });

  it('refuses a short session secret', () => {
    const result = production({ SESSION_SECRET: 'tooshort' });
    expect(result.ok).toBe(false);
  });

  it('refuses a build with no identifiable commit', () => {
    // "Which version are you running" is the first question on a support call.
    const result = production({ BUILD_SHA: 'unknown' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('BUILD_SHA');
  });

  it('refuses s3 storage with missing credentials', () => {
    const result = production({ S3_BUCKET: '' });
    expect(result.ok).toBe(false);
    expect(problemsOf(result)).toContain('S3_BUCKET');
  });
});

describe('development stays permissive', () => {
  it('accepts the mock provider and local storage', () => {
    const result = parseConfig({
      DATABASE_URL: 'postgresql://app:pw@localhost:5434/dev',
      SESSION_SECRET: 'Zx9Kq2mTrv7BnLdWpAeJhYcUgSf4NiRoQ3XbMzVt',
    } as unknown as NodeJS.ProcessEnv);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.APP_ENV).toBe('development');
    expect(result.value.AI_PROVIDER).toBe('mock');
    expect(result.value.FILE_STORAGE_DRIVER).toBe('local');
  });

  it('defaults APP_ENV to development, so production must be asked for explicitly', () => {
    // The safe direction. A deployment that forgets the variable gets refused by the production
    // checks rather than quietly running with development's guard rails.
    const result = parseConfig({
      DATABASE_URL: 'postgresql://a:b@localhost:5434/d',
      SESSION_SECRET: 'Zx9Kq2mTrv7BnLdWpAeJhYcUgSf4NiRoQ3XbMzVt',
    } as unknown as NodeJS.ProcessEnv);
    expect(result.ok && result.value.APP_ENV).toBe('development');
  });
});

describe('staging can rehearse a release', () => {
  it('runs a production build against synthetic data with the mock provider', () => {
    // The whole reason APP_ENV exists alongside NODE_ENV. Deciding this with NODE_ENV would mean
    // either staging cannot rehearse properly or production inherits staging's permissions.
    const result = parseConfig({
      ...base,
      APP_ENV: 'staging',
      NODE_ENV: 'production',
      AI_PROVIDER: 'mock',
      ANTHROPIC_API_KEY: '',
      FILE_STORAGE_DRIVER: 'local',
      BUILD_SHA: 'unknown',
    } as unknown as NodeJS.ProcessEnv);

    expect(problemsOf(result)).toBe('');
  });

  it('still requires an application URL', () => {
    const result = parseConfig({
      ...base,
      APP_ENV: 'staging',
      APP_URL: undefined,
    } as unknown as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
  });
});

describe('the destructive-operation guard', () => {
  it('permits development and test', () => {
    for (const appEnv of ['development', 'test']) {
      expect(
        assessGuard('demo seed', { APP_ENV: appEnv } as unknown as NodeJS.ProcessEnv).allowed,
      ).toBe(true);
      expect(
        destructiveOperationsAllowed({ APP_ENV: appEnv } as unknown as NodeJS.ProcessEnv),
      ).toBe(true);
    }
  });

  it('refuses production and staging', () => {
    for (const appEnv of ['production', 'staging']) {
      const verdict = assessGuard('demo seed', { APP_ENV: appEnv } as unknown as NodeJS.ProcessEnv);
      expect(verdict.allowed, appEnv).toBe(false);
      expect(
        destructiveOperationsAllowed({ APP_ENV: appEnv } as unknown as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });

  it('explains itself, including the trigger bypass', () => {
    // The refusal has to say why, or somebody will assume it is over-cautious and work around it.
    const verdict = assessGuard('demo seed', {
      APP_ENV: 'production',
    } as unknown as NodeJS.ProcessEnv);
    expect(verdict.reason).toContain('trigger');
    expect(verdict.reason).toContain('APP_ENV=development');
  });

  it('agrees with the config layer for every environment', () => {
    // Two implementations of one rule that could drift. The guard cannot import the config layer
    // — it runs under tsx where `server-only` throws — so the agreement is pinned here instead.
    for (const appEnv of ['development', 'test', 'staging', 'production']) {
      const env = { APP_ENV: appEnv } as unknown as NodeJS.ProcessEnv;
      expect(assessGuard('demo seed', env).allowed, appEnv).toBe(destructiveOperationsAllowed(env));
    }
  });

  it('treats an unset APP_ENV as development', () => {
    expect(assessGuard('demo seed', {} as unknown as NodeJS.ProcessEnv).allowed).toBe(true);
  });
});

describe('the database target guard', () => {
  it('treats a local database as safe', () => {
    for (const host of ['localhost', '127.0.0.1', 'postgres']) {
      expect(looksLikeProductionDatabase(`postgresql://u:p@${host}:5432/db`), host).toBe(false);
    }
  });

  it('treats a remote database as production', () => {
    // The second, independent check. APP_ENV is a promise about a shell; this looks at where the
    // connection actually points, so one mistake is not enough to lose a distributor's records.
    expect(
      looksLikeProductionDatabase('postgresql://u:p@db.eu-west-1.rds.amazonaws.com/prod'),
    ).toBe(true);
  });

  it('does not fire on an absent or malformed url', () => {
    expect(looksLikeProductionDatabase(undefined)).toBe(false);
    expect(looksLikeProductionDatabase('not a url')).toBe(false);
  });
});

describe('rate limiting', () => {
  it('allows up to the limit and then refuses', () => {
    reset();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(consume('login', 'a@b.example').allowed, `attempt ${attempt}`).toBe(true);
    }
    const verdict = consume('login', 'a@b.example');
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys separately per subject, so one person cannot lock out another', () => {
    reset();
    for (let attempt = 0; attempt < 10; attempt += 1) consume('login', 'a@b.example');
    expect(consume('login', 'other@b.example').allowed).toBe(true);
  });

  it('keys separately per limit', () => {
    reset();
    for (let attempt = 0; attempt < 10; attempt += 1) consume('login', 'a@b.example');
    expect(consume('aiParse', 'a@b.example').allowed).toBe(true);
  });

  it('forgives the window once it has passed', () => {
    reset();
    const start = 1_000_000;
    for (let attempt = 0; attempt < 10; attempt += 1) consume('login', 'x@y.example', start);
    expect(consume('login', 'x@y.example', start).allowed).toBe(false);
    // Fifteen minutes and one second later.
    expect(consume('login', 'x@y.example', start + 15 * 60_000 + 1_000).allowed).toBe(true);
  });

  it('can be reset for a subject, which is what a successful login does', () => {
    reset();
    for (let attempt = 0; attempt < 10; attempt += 1) consume('login', 'a@b.example');
    expect(consume('login', 'a@b.example').allowed).toBe(false);

    reset('login', 'a@b.example');
    // Somebody who eventually remembers their password is not locked out by the attempts it took.
    expect(consume('login', 'a@b.example').allowed).toBe(true);
  });
});
