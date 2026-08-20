-- Fixes a fragile RLS predicate.
--
-- The original policies read:
--
--   organization_id = current_setting('app.organization_id', true)::uuid
--
-- That works on a connection where the setting has never been assigned: current_setting
-- returns NULL, the comparison is NULL, and no rows are visible. Fail-closed, as intended.
--
-- But `set_config(..., true)` is transaction-local, and once a GUC has been assigned at least
-- once in a session, reverting it leaves an EMPTY STRING rather than an unset value. On the
-- next query outside a transaction, the predicate becomes ''::uuid, and Postgres raises
-- `invalid input syntax for type uuid` instead of returning no rows.
--
-- Connections are pooled, so in practice every connection has served a tenant-scoped
-- transaction before, and this is the state an unscoped query actually meets. The failure was
-- still safe — an error returns no data — but "the query explodes" is a poor substitute for
-- "the query returns nothing", and an error surfaces to a user as a crash rather than as an
-- empty page.
--
-- NULLIF collapses both the unset and the empty case to NULL, so the predicate is uniformly
-- NULL and the policy hides everything.

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
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)
         WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), '''')::uuid)',
      target
    );
  END LOOP;
END
$$;
