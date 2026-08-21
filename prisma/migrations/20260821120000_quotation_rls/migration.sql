-- Row-Level Security for the Phase 3 tables.
--
-- Same NULLIF-guarded predicate as every other business table: on a pooled connection that has
-- already served a scoped transaction, `app.organization_id` reverts to an empty string rather
-- than to unset, and an unguarded ''::uuid cast raises instead of hiding rows.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'quotations',
    'quotation_items',
    'quotation_approvals'
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

-- An approval record is evidence of who authorised which exact figures. Rewriting one after
-- the fact would defeat the point of recording it, so the application role may only append.
REVOKE UPDATE, DELETE ON quotation_approvals FROM distributor_app;

-- Belt and braces on the money path: the database refuses a negative total outright, so a
-- calculation bug cannot quietly persist one and be discovered on a customer's desk.
ALTER TABLE quotations
  ADD CONSTRAINT quotations_totals_non_negative CHECK (
    subtotal_minor >= 0
    AND discount_total_minor >= 0
    AND delivery_fee_minor >= 0
    AND delivery_tax_minor >= 0
    AND tax_total_minor >= 0
    AND grand_total_minor >= 0
  );

ALTER TABLE quotation_items
  ADD CONSTRAINT quotation_items_sane CHECK (
    quantity > 0
    AND discount_bp >= 0
    AND discount_bp <= 10000
    AND tax_rate_bp >= 0
    AND list_unit_price_minor >= 0
    AND quoted_unit_price_minor >= 0
    AND line_total_minor >= 0
  );
