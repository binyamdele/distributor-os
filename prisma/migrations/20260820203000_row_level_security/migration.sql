-- Row-Level Security: layer 2 of the tenancy guarantee.
--
-- Layer 1 is the Prisma client extension in src/platform/db/tenant.ts, which injects the
-- organization filter into every query. Layer 2 is this file, which makes the database refuse
-- an unscoped read even if layer 1 were bypassed or wrong. Layer 3 is tests/tenancy/.
--
-- How it works: withTenant() sets `app.organization_id` for the duration of a transaction with
-- set_config(..., true). The policies below read it. When it is unset, current_setting returns
-- NULL, every comparison is NULL, and no rows are visible — the failure mode is an empty
-- result, never someone else's data.
--
-- This applies only to non-superusers, which is why the application connects as
-- distributor_app (see docker/init-test-db.sql). FORCE is used so the policies also bind the
-- table owner; superusers still bypass RLS unconditionally, and migrations run as one.
--
-- DELIBERATE EXCEPTION — the identity-plane tables are not listed here:
--
--   users, organizations, memberships, sessions
--
-- Authentication necessarily runs *before* an organization is known: a person types an email
-- address, and only after their password verifies and their memberships are read can a tenant
-- be chosen. A fail-closed policy on those tables would make login impossible. They are scoped
-- by layer 1 and by explicit query construction instead, and tests/tenancy/schema-coverage
-- asserts this exact partition so it cannot drift into an accident.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'organization_settings',
    'customers',
    'products',
    'product_aliases',
    'stock_adjustments',
    'audit_events',
    'number_sequences'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (organization_id = current_setting(''app.organization_id'', true)::uuid)
         WITH CHECK (organization_id = current_setting(''app.organization_id'', true)::uuid)',
      target
    );
  END LOOP;
END
$$;

-- Trigram index for Phase 2 product matching. Created now because the alias table exists now,
-- and because an index added alongside its table is one nobody has to remember later.
CREATE INDEX IF NOT EXISTS product_aliases_normalized_trgm
  ON product_aliases USING gin (normalized_alias gin_trgm_ops);

-- The audit log is append-only. Revoking rather than trusting: an UPDATE or DELETE on a
-- recorded event is not a thing the application should be able to do by mistake.
REVOKE UPDATE, DELETE ON audit_events FROM distributor_app;
