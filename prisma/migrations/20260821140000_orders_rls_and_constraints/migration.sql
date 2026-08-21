-- Row-Level Security and the invariants that must not depend on application code.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'quotation_follow_ups',
    'sales_orders',
    'sales_order_items',
    'stock_reservations'
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

-- ---------------------------------------------------------------------------
-- One active order per quotation.
--
-- The application checks for an existing order before creating one, but a check followed by an
-- insert is two operations, and a double-clicked button can slip between them. A partial unique
-- index makes the second insert fail at the database instead.
--
-- Partial rather than total, so a cancelled order does not permanently prevent the quotation
-- from being converted again — which is a legitimate thing to want after a mistake.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX sales_orders_one_active_per_quotation
  ON sales_orders (quotation_id)
  WHERE status <> 'CANCELLED';

-- ---------------------------------------------------------------------------
-- Quantities and money cannot be nonsense.
-- ---------------------------------------------------------------------------
ALTER TABLE sales_order_items
  ADD CONSTRAINT sales_order_items_sane CHECK (
    quantity > 0
    AND reserved_quantity >= 0
    AND reserved_quantity <= quantity
    AND discount_bp >= 0
    AND discount_bp <= 10000
    AND tax_rate_bp >= 0
    AND list_unit_price_minor >= 0
    AND quoted_unit_price_minor >= 0
    AND line_total_minor >= 0
  );

ALTER TABLE sales_orders
  ADD CONSTRAINT sales_orders_totals_non_negative CHECK (
    subtotal_minor >= 0
    AND discount_total_minor >= 0
    AND delivery_fee_minor >= 0
    AND delivery_tax_minor >= 0
    AND tax_total_minor >= 0
    AND grand_total_minor >= 0
  );

-- A reservation for zero or a negative number of units is not a reservation.
ALTER TABLE stock_reservations
  ADD CONSTRAINT stock_reservations_quantity_positive CHECK (quantity > 0);

-- ---------------------------------------------------------------------------
-- Stock can never be committed beyond what is on hand.
--
-- The reservation code checks availability under a row lock, which is where the rule is
-- actually enforced. This constraint is the backstop: if that logic is ever wrong, the write
-- fails rather than leaving the distributor promising goods that do not exist.
-- ---------------------------------------------------------------------------
ALTER TABLE products
  ADD CONSTRAINT products_reserved_within_available CHECK (
    reserved_stock >= 0 AND reserved_stock <= available_stock
  );

-- A follow-up cannot be the zeroth chase.
ALTER TABLE quotation_follow_ups
  ADD CONSTRAINT quotation_follow_ups_sequence_positive CHECK (sequence > 0);

-- Reservations are evidence of what an order committed. Releasing sets a status; it never
-- deletes the row, and nothing should rewrite history after the fact.
REVOKE DELETE ON stock_reservations FROM distributor_app;
