-- Row-Level Security and the payment invariants that must not depend on application code.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['payments', 'payment_evidence_files']
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
-- One confirmed payment per provider reference, per organization.
--
-- A bank reference identifies a transfer. Two confirmed payments carrying the same one are
-- either a double-claim on a single transfer or a typo, and both need a person to look — so the
-- second confirmation fails at the database rather than quietly applying the money twice.
--
-- Partial, and scoped to CONFIRMED only: a submitted or rejected payment may legitimately carry
-- a reference that is later used by the confirmed one. Scoped to (organization, provider,
-- reference) because reference formats collide freely between providers and nothing guarantees
-- global uniqueness.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX payments_one_confirmed_reference
  ON payments (organization_id, coalesce(provider_name, ''), transaction_reference)
  WHERE status = 'CONFIRMED' AND transaction_reference IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Money on a payment cannot be nonsense.
--
-- The confirmed amount must be present exactly when the payment is confirmed and absent
-- otherwise, so a rejected or pending row can never contribute to a balance.
-- ---------------------------------------------------------------------------
ALTER TABLE payments
  ADD CONSTRAINT payments_amounts_sane CHECK (
    amount_claimed_minor > 0
    AND (amount_confirmed_minor IS NULL OR amount_confirmed_minor > 0)
    AND (
      (status = 'CONFIRMED' AND amount_confirmed_minor IS NOT NULL)
      OR (status <> 'CONFIRMED' AND amount_confirmed_minor IS NULL)
    )
  );

-- A confirmation without its payload hash would be an approval nobody can verify.
ALTER TABLE payments
  ADD CONSTRAINT payments_confirmed_has_hash CHECK (
    status <> 'CONFIRMED' OR confirmation_payload_hash IS NOT NULL
  );

ALTER TABLE payment_evidence_files
  ADD CONSTRAINT payment_evidence_sane CHECK (
    size_bytes > 0 AND length(content_hash) = 64
  );

-- ---------------------------------------------------------------------------
-- Confirmed payments are immutable, and evidence is never destroyed.
--
-- Correcting a confirmed payment in place would rewrite what Finance put their name to. The
-- MVP answer is that it cannot be done at all; a future phase adds reversal, which records a
-- second fact rather than editing the first.
--
-- Enforced by trigger rather than by grant, because the application legitimately updates
-- non-confirmed rows through the same role.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refuse_confirmed_payment_mutation() RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'a confirmed payment cannot be deleted';
  END IF;

  IF (OLD.status = 'CONFIRMED') THEN
    RAISE EXCEPTION 'a confirmed payment is immutable; record a reversal instead';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_confirmed_immutable
  BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW
  WHEN (OLD.status = 'CONFIRMED')
  EXECUTE FUNCTION refuse_confirmed_payment_mutation();

-- Evidence is what a confirmation refers to. Removing it would orphan the approval.
REVOKE DELETE ON payment_evidence_files FROM distributor_app;
