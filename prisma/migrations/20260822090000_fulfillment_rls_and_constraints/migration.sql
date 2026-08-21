-- Row-Level Security and the fulfilment invariants that must not depend on application code.
--
-- Timestamped deliberately after the migration that creates these tables. Prisma applies
-- migrations in lexicographic order; the Phase 5 equivalent was written the other way round and
-- a deploy against an empty database failed on a table that did not exist yet.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['warehouse_tasks', 'warehouse_task_items', 'deliveries']
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
-- One active warehouse task per order.
--
-- Two tasks against one order would each believe they own the same reservations, and the
-- second to complete would try to consume stock that has already left. The application checks
-- for an existing task before creating one; this index is what holds when two requests arrive
-- in the same millisecond and both find none.
--
-- Partial: a cancelled task must not block a replacement, which is the whole point of being
-- able to cancel one.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX warehouse_tasks_one_active_per_order
  ON warehouse_tasks (organization_id, sales_order_id)
  WHERE status <> 'CANCELLED';

-- One live delivery per order, on the same reasoning.
CREATE UNIQUE INDEX deliveries_one_active_per_order
  ON deliveries (organization_id, sales_order_id)
  WHERE status NOT IN ('CANCELLED', 'FAILED');

-- ---------------------------------------------------------------------------
-- Warehouse task timestamps must agree with the status.
--
-- A COMPLETED task without a completed_at is a task nobody can place in time, and the
-- fulfilment metrics would silently compute from nulls.
-- ---------------------------------------------------------------------------
ALTER TABLE warehouse_tasks
  ADD CONSTRAINT warehouse_tasks_timestamps_match_status CHECK (
    (status <> 'IN_PROGRESS' OR started_at IS NOT NULL)
    AND (status <> 'PREPARED' OR (started_at IS NOT NULL AND prepared_at IS NOT NULL))
    AND (status <> 'COMPLETED' OR (prepared_at IS NOT NULL AND completed_at IS NOT NULL))
    AND (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- No partial fulfilment, enforced by the database and not only by intention.
--
-- A task item is either untouched or picked in full. Phase 6 has no split shipment, and the
-- cheapest way to keep it that way is to make a partial quantity unrepresentable.
-- ---------------------------------------------------------------------------
ALTER TABLE warehouse_task_items
  ADD CONSTRAINT warehouse_task_items_all_or_nothing CHECK (
    quantity_required > 0
    AND (
      (status = 'PENDING' AND quantity_prepared = 0)
      OR (status = 'PREPARED' AND quantity_prepared = quantity_required)
    )
  );

-- ---------------------------------------------------------------------------
-- Delivery timestamps and the failure reason must agree with the status.
--
-- FAILED without a moment it failed at, or DELIVERED and FAILED both stamped, would make the
-- delivery history unreadable exactly when someone is disputing it.
-- ---------------------------------------------------------------------------
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_timestamps_match_status CHECK (
    (status <> 'DISPATCHED' OR dispatched_at IS NOT NULL)
    AND (status <> 'DELIVERED' OR (dispatched_at IS NOT NULL AND delivered_at IS NOT NULL))
    AND (status <> 'FAILED' OR (dispatched_at IS NOT NULL AND failed_at IS NOT NULL))
    AND NOT (delivered_at IS NOT NULL AND failed_at IS NOT NULL)
  );

-- A delivery must know where it is going. An empty destination is a run nobody can make.
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_has_destination CHECK (length(btrim(destination_text_snapshot)) > 0);

-- ---------------------------------------------------------------------------
-- Physical stock can never go negative.
--
-- Phase 4 already enforces `reserved_stock >= 0 AND reserved_stock <= available_stock`, which
-- was the whole story while reservation was the only thing that touched these columns. Phase 6
-- adds the first operation that decrements `available_stock`, and that opens a failure mode the
-- earlier constraint cannot see: consuming more than is on hand drives it below zero while the
-- relationship between the two columns still holds.
--
-- Narrow on purpose. Restating the Phase 4 predicate here would mean two constraints failing
-- together on the same write, and the error message naming whichever the planner reached first.
-- ---------------------------------------------------------------------------
ALTER TABLE products
  ADD CONSTRAINT products_available_stock_non_negative CHECK (available_stock >= 0);

-- ---------------------------------------------------------------------------
-- A consumed reservation is history. It must not be edited or deleted.
--
-- The same reasoning as the confirmed-payment trigger in Phase 5: CONSUMED is the record that
-- specific goods left the yard against a specific order, and rewriting it in place would erase
-- the only trace of that. A correction is a stock adjustment — a second, separately audited
-- event — not an edit of the first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION stock_reservations_consumed_immutable()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'a consumed stock reservation cannot be deleted';
  END IF;
  RAISE EXCEPTION 'a consumed stock reservation cannot be modified';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER stock_reservations_consumed_immutable
  BEFORE UPDATE OR DELETE ON stock_reservations
  FOR EACH ROW
  WHEN (OLD.status = 'CONSUMED')
  EXECUTE FUNCTION stock_reservations_consumed_immutable();
