import { defineWorkspace } from 'vitest/config';
import { testAlias } from './vitest.config';

/**
 * Two projects, because they have different costs and different reasons to fail.
 *
 * `unit` runs pure functions with no database — money arithmetic, alias normalisation, the
 * permission matrix. Fast enough to run on every save.
 *
 * `integration` runs against a real PostgreSQL, because the properties worth asserting there
 * are database properties: RLS actually refusing a query, an advisory lock actually
 * serialising, a transaction actually rolling an audit row back. A mocked database would only
 * assert that the mock behaves as written, which is a much weaker claim than the one being made.
 */
export default defineWorkspace([
  {
    resolve: { alias: testAlias },
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
      environment: 'node',
    },
  },
  {
    resolve: { alias: testAlias },
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts', 'tests/tenancy/**/*.test.ts'],
      environment: 'node',
      setupFiles: ['tests/support/setup.ts'],
      /*
       * One process, one file at a time.
       *
       * These tests share a single database and truncate it between files. Run in parallel,
       * one file's TRUNCATE deletes the rows another file is mid-way through asserting on —
       * which surfaces as foreign-key violations and duplicate-email errors that look like
       * product bugs and are not. A single fork is what actually serialises them —
       * `fileParallelism` is a root-level option and has no effect inside a project.
       */
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      testTimeout: 30_000,
      hookTimeout: 120_000,
    },
  },
]);
