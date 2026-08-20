import { describe, expect, it } from 'vitest';
import {
  EXTENSION_SCOPED_ONLY_MODELS,
  INTENTIONALLY_GLOBAL_MODELS,
  TENANT_SCOPED_MODELS,
} from '@/platform/db';
import { MODELS } from '../support/prisma-meta';
import { owner } from '../support/fixtures';

/** Scoped models that must carry an RLS policy — everything except the two login-path tables. */
const RLS_REQUIRED = MODELS.filter(
  (model) =>
    TENANT_SCOPED_MODELS.has(model.name) && !(model.name in EXTENSION_SCOPED_ONLY_MODELS),
);

/**
 * The test that makes the tenancy guarantee survive future phases.
 *
 * Phases 2 to 7 add roughly a dozen tables — inquiries, quotations, orders, payments,
 * warehouse tasks, deliveries. Any one of them could be added without an `organizationId`, or
 * with one but no RLS policy, and nothing else in the suite would notice: the new feature's own
 * tests would pass, because they would only ever query within a single organization.
 *
 * So this test does not check a list. It enumerates the *actual* schema and requires every
 * model to be either scoped or explicitly, visibly excused.
 */
describe('schema tenancy coverage', () => {
  it('classifies every model as scoped or deliberately global', () => {
    const unclassified = MODELS.filter(
      (model) =>
        !TENANT_SCOPED_MODELS.has(model.name) && !(model.name in INTENTIONALLY_GLOBAL_MODELS),
    ).map((model) => model.name);

    expect(
      unclassified,
      `These models are neither tenant-scoped nor listed as intentionally global. Add ` +
        `organizationId and register them in TENANT_SCOPED_MODELS, or record why they are ` +
        `global in INTENTIONALLY_GLOBAL_MODELS with a reason.`,
    ).toEqual([]);
  });

  it('requires every model claiming to be scoped to actually have the column', () => {
    const missing = MODELS.filter(
      (model) => TENANT_SCOPED_MODELS.has(model.name) && !model.fields.includes('organizationId'),
    ).map((model) => model.name);

    expect(missing).toEqual([]);
  });

  it('requires every model with an organizationId to be registered as scoped', () => {
    const unregistered = MODELS.filter(
      (model) =>
        model.fields.includes('organizationId') &&
        !TENANT_SCOPED_MODELS.has(model.name) &&
        !(model.name in INTENTIONALLY_GLOBAL_MODELS),
    ).map((model) => model.name);

    expect(unregistered).toEqual([]);
  });

  it('protects every scoped table with a row-level security policy', async () => {
    const scopedTables = RLS_REQUIRED.map((model) => model.tableName);

    const policies = await owner.$queryRaw<{ tablename: string; policyname: string }[]>`
      SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
    `;
    const protectedTables = new Set(policies.map((row) => row.tablename));

    const unprotected = scopedTables.filter((table) => !protectedTables.has(table));
    expect(
      unprotected,
      'These tenant-scoped tables have no RLS policy. Add one in a migration.',
    ).toEqual([]);
  });

  it('forces row-level security so the table owner is bound by it too', async () => {
    const scopedTables = RLS_REQUIRED.map((model) => model.tableName);

    const rows = await owner.$queryRaw<{ relname: string; relforcerowsecurity: boolean }[]>`
      SELECT relname, relforcerowsecurity
        FROM pg_class
       WHERE relname = ANY(${scopedTables}::text[])
    `;

    for (const row of rows) {
      expect(row.relforcerowsecurity, `${row.relname} does not FORCE row level security`).toBe(
        true,
      );
    }
    expect(rows).toHaveLength(scopedTables.length);
  });

  it('records a reason for each intentionally global model', () => {
    for (const [model, reason] of Object.entries(INTENTIONALLY_GLOBAL_MODELS)) {
      expect(reason.length, `${model} needs a real reason, not a placeholder`).toBeGreaterThan(20);
    }
  });

  /**
   * The exception list is the soft spot in the whole scheme: anything placed on it is protected
   * by one layer instead of two. Pinning it to exactly the two login-path tables means a future
   * phase cannot quietly park a business table there to make a failing test go away.
   */
  it('keeps the RLS exception to the login path and nothing else', () => {
    expect(Object.keys(EXTENSION_SCOPED_ONLY_MODELS).sort()).toEqual(['Membership', 'Session']);
  });

  it('records a reason for each RLS exception', () => {
    for (const [model, reason] of Object.entries(EXTENSION_SCOPED_ONLY_MODELS)) {
      expect(reason.length, `${model} needs a real reason, not a placeholder`).toBeGreaterThan(20);
    }
  });

  it('still requires the exempt models to be tenant-scoped by the extension', () => {
    for (const model of Object.keys(EXTENSION_SCOPED_ONLY_MODELS)) {
      expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    }
  });
});
