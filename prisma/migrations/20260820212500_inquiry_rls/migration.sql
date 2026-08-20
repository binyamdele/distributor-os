-- Row-Level Security for the Phase 2 tables.
--
-- Same predicate as the Phase 1 tables, including the NULLIF guard: on a pooled connection
-- that has already served a scoped transaction, `app.organization_id` reverts to an empty
-- string rather than to unset, and an unguarded ''::uuid cast raises instead of hiding rows.
--
-- These three carry business data and customer text, so none of them qualifies for the
-- login-path exemption that memberships and sessions have. FORCE, so the policies bind the
-- table owner as well.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'inquiries',
    'inquiry_item_proposals',
    'ai_interactions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
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

-- The AI interaction log is evidence about what a provider was asked and whether it answered
-- validly. Rewriting it after the fact would defeat the point.
REVOKE UPDATE, DELETE ON ai_interactions FROM distributor_app;
