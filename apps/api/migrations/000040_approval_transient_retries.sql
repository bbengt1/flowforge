-- Transient approval rebuild backoff.
--
-- A flow.approval claim that cannot rebuild its requirement is queued
-- again without burning attempt. approval_transient_retries counts those
-- retries so the next claim waits out an exponential backoff. This
-- migration adds that column only. It does not set row_security off and
-- does not grant BYPASSRLS.

ALTER TABLE execution_jobs
    ADD COLUMN approval_transient_retries integer NOT NULL DEFAULT 0;

ALTER TABLE execution_jobs
    DROP CONSTRAINT IF EXISTS execution_jobs_transient_retries_nonneg;

ALTER TABLE execution_jobs
    ADD CONSTRAINT execution_jobs_transient_retries_nonneg
    CHECK (approval_transient_retries >= 0);
