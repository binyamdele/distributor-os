-- The import record is append-only, so it cannot also be unique.
--
-- The first version of this table had a unique index on (organization, kind, fingerprint) *and*
-- revoked UPDATE. Those two decisions contradict each other, and the contradiction only showed
-- up when an operator deliberately re-imported a price list: the application could neither
-- insert a second row (the index refused) nor update the first (the revoke refused).
--
-- The revoke is the one worth keeping. An import record is evidence that a file was loaded, and
-- evidence that can be rewritten is not evidence — the same reasoning as the audit log, the
-- movement ledger and the confirmed-payment trigger. So a repeat import now appends a second
-- row, and the history reads "imported on the 1st, imported again on the 5th", which is more
-- truthful than one mutated row claiming only the later import happened.
--
-- Losing the unique index costs less than it appears to. It never enforced idempotency for the
-- case that matters: a *different* file — re-exported, one row edited, saved under a new name —
-- has a different fingerprint and always slipped past it. What actually prevents an opening
-- balance being applied twice is the conditional `UPDATE ... WHERE available_stock = 0` in the
-- commit path, which catches both the same file and a different one, and which is a genuine
-- database-level guarantee rather than an index that looked like one.

DROP INDEX IF EXISTS "import_jobs_organization_id_kind_fingerprint_key";

-- The lookup the duplicate warning performs, which is all the index was really needed for.
CREATE INDEX IF NOT EXISTS import_jobs_lookup
  ON import_jobs (organization_id, kind, fingerprint);
