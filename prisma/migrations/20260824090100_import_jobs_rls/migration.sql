-- Row-Level Security for the import record.
--
-- Timestamped after the migration that creates the table, as Phases 5–7 learned to do.

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON import_jobs;
CREATE POLICY tenant_isolation ON import_jobs
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- An import that imported nothing is not a record worth keeping, and a negative
-- count is arithmetic that went wrong somewhere upstream.
-- ---------------------------------------------------------------------------
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_counts_sane CHECK (
    row_count >= 0 AND created_count >= 0 AND updated_count >= 0
  );

-- A fingerprint is a SHA-256 hex digest or it is not a fingerprint.
ALTER TABLE import_jobs
  ADD CONSTRAINT import_jobs_fingerprint_is_sha256 CHECK (length(fingerprint) = 64);

-- ---------------------------------------------------------------------------
-- The import record is the evidence that a file was already loaded.
--
-- Deleting one would make the same opening-stock file importable a second time, which is the
-- exact silent doubling the record exists to prevent — and the resulting figures would all look
-- entirely plausible. Editing one would be worse: it would change what the system believes was
-- imported without changing what actually was.
--
-- The same reasoning as the audit log and the movement ledger. A mistaken import is corrected by
-- a counted stock adjustment, which is a second recorded fact, not by erasing the first.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON import_jobs FROM distributor_app;
