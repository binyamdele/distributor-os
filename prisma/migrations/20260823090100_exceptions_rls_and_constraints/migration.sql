-- Row-Level Security and the exception invariants that must not depend on application code.
--
-- Timestamped after the migration that creates these tables, as Phases 5 and 6 learned to do.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['inventory_discrepancies', 'returns', 'return_items']
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

-- The renamed ledger keeps the policy it had as stock_adjustments — a rename does not carry a
-- policy name forward reliably, so it is restated rather than assumed.
ALTER TABLE inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_movements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_movements;
CREATE POLICY tenant_isolation ON inventory_movements
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- A movement that moved nothing is noise in the one history a stock dispute is settled from.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_delta_non_zero CHECK (delta <> 0);

-- Resulting stock is a physical quantity. It cannot be negative, whatever produced it.
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_stock_after_non_negative CHECK (stock_after >= 0);

-- ---------------------------------------------------------------------------
-- The ledger is history. It is appended to, never edited.
--
-- The same reasoning as the confirmed-payment and consumed-reservation triggers: a movement row
-- is the answer to "why did Rebar 12mm decrease by 40", and an answer that can be rewritten
-- afterwards is not one. A mistaken movement is corrected by a second, opposite movement — which
-- is also how a physical stock correction actually works.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON inventory_movements FROM distributor_app;

-- ---------------------------------------------------------------------------
-- The variance is arithmetic, not an opinion.
--
-- Storing it as a column makes the exceptions list sortable without recomputing, and this
-- constraint makes it impossible for the stored figure to disagree with the two it comes from.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_discrepancies
  ADD CONSTRAINT inventory_discrepancies_variance_is_derived CHECK (
    variance_quantity = physical_count_quantity - system_on_hand_quantity
  );

-- Counts are physical quantities; none of them can be negative.
ALTER TABLE inventory_discrepancies
  ADD CONSTRAINT inventory_discrepancies_counts_non_negative CHECK (
    system_on_hand_quantity >= 0
    AND system_reserved_quantity >= 0
    AND physical_count_quantity >= 0
    AND (expected_task_quantity IS NULL OR expected_task_quantity >= 0)
    AND (reservation_shortfall IS NULL OR reservation_shortfall > 0)
  );

-- ---------------------------------------------------------------------------
-- A discrepancy cannot resolve twice, and cannot be resolved without saying how.
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_discrepancies
  ADD CONSTRAINT inventory_discrepancies_resolution_matches_status CHECK (
    (status = 'RESOLVED' AND resolution_type IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status <> 'RESOLVED' AND resolution_type IS NULL AND resolved_at IS NULL)
  );

CREATE OR REPLACE FUNCTION inventory_discrepancies_resolved_immutable()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'a resolved inventory discrepancy cannot be deleted';
  END IF;
  RAISE EXCEPTION 'a resolved inventory discrepancy cannot be modified';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER inventory_discrepancies_resolved_immutable
  BEFORE UPDATE OR DELETE ON inventory_discrepancies
  FOR EACH ROW
  WHEN (OLD.status = 'RESOLVED')
  EXECUTE FUNCTION inventory_discrepancies_resolved_immutable();

-- ---------------------------------------------------------------------------
-- One live return per delivery.
--
-- Two return records against one failed delivery would each believe they own the same physical
-- goods, and the second to complete would restock quantity that came back once. Partial:
-- a cancelled return must not block a replacement.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX returns_one_live_per_delivery
  ON returns (organization_id, delivery_id)
  WHERE status <> 'CANCELLED';

-- Timestamps must agree with the status, so a completed return can be placed in time.
ALTER TABLE returns
  ADD CONSTRAINT returns_timestamps_match_status CHECK (
    (status <> 'RECEIVED' OR received_at IS NOT NULL)
    AND (status <> 'INSPECTED' OR (received_at IS NOT NULL AND inspected_at IS NOT NULL))
    AND (status <> 'COMPLETED' OR (received_at IS NOT NULL AND inspected_at IS NOT NULL AND completed_at IS NOT NULL))
  );

-- ---------------------------------------------------------------------------
-- Nothing disappears, and nothing appears from nowhere.
--
--     received = restockable + damaged
--     expected = received + missing
--
-- Both halves matter. The first stops quantity being restocked that was never inspected; the
-- second stops quantity that failed to arrive being silently dropped out of the sum instead of
-- being recorded as missing. Together they make the history add up: eighty left, and eighty are
-- accounted for as sellable, broken, or gone.
--
-- Everything is bounded above by what actually went out on the delivery, because a return
-- cannot bring back more than was dispatched.
-- ---------------------------------------------------------------------------
ALTER TABLE return_items
  ADD CONSTRAINT return_items_quantities_balance CHECK (
    quantity_dispatched > 0
    AND quantity_expected >= 0
    AND quantity_received >= 0
    AND quantity_restockable >= 0
    AND quantity_damaged >= 0
    AND quantity_missing >= 0
    AND quantity_expected <= quantity_dispatched
    AND quantity_received = quantity_restockable + quantity_damaged
    AND quantity_expected = quantity_received + quantity_missing
  );

-- ---------------------------------------------------------------------------
-- A delivery cannot be a retry of itself.
--
-- Cheap to write and impossible to reason about if it ever happened: the attempt history would
-- be a cycle, and "which attempt came first" would have no answer.
-- ---------------------------------------------------------------------------
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_retry_not_self CHECK (retry_of_delivery_id IS NULL OR retry_of_delivery_id <> id);

ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_attempt_number_positive CHECK (attempt_number >= 1);

-- ---------------------------------------------------------------------------
-- One retry per failed attempt.
--
-- A double-clicked "Retry delivery" would otherwise put two vehicles on the road against one
-- shipment. The application checks first; this is what holds when both requests check before
-- either writes. Partial, so a retry that is itself cancelled does not block another.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX deliveries_one_retry_per_attempt
  ON deliveries (organization_id, retry_of_delivery_id)
  WHERE retry_of_delivery_id IS NOT NULL AND status <> 'CANCELLED';

-- A resolution belongs only to a delivery that actually failed.
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_resolution_requires_failure CHECK (
    failure_resolution IS NULL OR status = 'FAILED'
  );
