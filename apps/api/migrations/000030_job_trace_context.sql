-- G.2.4: persist W3C trace context on the job so a worker continues the
-- enqueue span. Values are correlation identifiers. Invalid or
-- secret-like headers are stored as NULL by the application; the
-- checks reject anything else. Existing RLS and tenancy are unchanged.

ALTER TABLE execution_jobs
    ADD COLUMN IF NOT EXISTS traceparent text,
    ADD COLUMN IF NOT EXISTS tracestate text;

ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_traceparent_fmt;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_traceparent_fmt
    CHECK (traceparent IS NULL OR traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_tracestate_len;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_tracestate_len
    CHECK (
        tracestate IS NULL
        OR (char_length(tracestate) BETWEEN 1 AND 512 AND tracestate !~ '[[:cntrl:]]')
    );
