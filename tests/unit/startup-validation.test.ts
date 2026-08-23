import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, resetConfigCache } from '@/platform/config';
import { captureException, setErrorReporterOverride } from '@/platform/observability/errors';

/**
 * What happens when the environment itself is wrong.
 *
 * Both of these were found by rehearsing a bad deployment rather than by reading code: a
 * container was started with `APP_ENV=production` and `FILE_STORAGE_DRIVER=local` — the exact
 * combination the guards exist to refuse — and it came up healthy, served nothing useful, and
 * could not say why.
 */

const valid = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://app:pw@db.example.com:5432/prod',
  SESSION_SECRET: 'Zx9Kq2mTrv7BnLdWpAeJhYcUgSf4NiRoQ3XbMzVt',
  APP_URL: 'https://pilot.example.com',
  BUILD_SHA: 'abc1234',
  AI_PROVIDER: 'disabled',
  FILE_STORAGE_DRIVER: 's3',
  S3_BUCKET: 'evidence',
  S3_REGION: 'eu-west-1',
  S3_ACCESS_KEY_ID: 'AKIA',
  S3_SECRET_ACCESS_KEY: 'secret',
} as const;

describe('the startup configuration check', () => {
  /*
   * `register()` itself calls process.exit, which cannot be asserted without either mocking the
   * process or spawning one. What is worth testing is the property the instrumentation hook
   * depends on: that a refusal names *every* problem in one pass.
   *
   * That matters operationally. Reporting one problem per attempt turns a five-setting mistake
   * into five deploys, and a deploy that fails five times in a row stops being read carefully.
   */
  it('reports every problem at once, not the first one', () => {
    const result = parseConfig({
      ...valid,
      FILE_STORAGE_DRIVER: 'local',
      AI_PROVIDER: 'mock',
      APP_URL: 'http://pilot.example.com',
      BUILD_SHA: 'unknown',
    } as unknown as NodeJS.ProcessEnv);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const named = result.problems.join('\n');
    expect(named).toContain('FILE_STORAGE_DRIVER');
    expect(named).toContain('AI_PROVIDER');
    expect(named).toContain('APP_URL');
    expect(named).toContain('BUILD_SHA');
    expect(result.problems.length).toBeGreaterThanOrEqual(4);
  });

  it('names settings without quoting their values', () => {
    const result = parseConfig({
      ...valid,
      SESSION_SECRET: 'changeme',
    } as unknown as NodeJS.ProcessEnv);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const named = result.problems.join('\n');
    expect(named).toContain('SESSION_SECRET');
    // The whole point of a startup message is that it lands in a deployment log, which is read
    // by more people and kept longer than anybody intends.
    expect(named).not.toContain('changeme');
  });
});

describe('reporting an error when the configuration is what is broken', () => {
  afterEach(() => {
    delete process.env.APP_ENV_BROKEN_FOR_TEST;
    resetConfigCache();
    setErrorReporterOverride(null);
  });

  it('still produces a reference instead of throwing again', () => {
    const saved = process.env.APP_ENV;
    try {
      // An APP_ENV outside the enum makes every config() call throw, which is the state a
      // misconfigured container is actually in.
      process.env.APP_ENV = 'not-an-environment';
      resetConfigCache();
      setErrorReporterOverride(null);

      /*
       * The regression this guards. `errorReporter()` read `config()` to decide where to send
       * errors, so when the failure being reported *was* a configuration failure, reporting it
       * threw as well. The readiness route's catch — the code whose entire job is to turn an
       * exception into a diagnosable 503 — became a bare HTTP 500 with an empty body.
       */
      const reference = captureException(new Error('database unreachable'), {
        event: 'test.config_broken',
      });

      expect(reference).toMatch(/^req_/);
    } finally {
      if (saved === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = saved;
      resetConfigCache();
    }
  });
});
