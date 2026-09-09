-- E5.1: persist executions, steps, jobs, and workspace audit events.
-- Expands the E3.2 pin stub. Lease/fencing columns exist for E5.2 but are
-- unused here. Approvals (E4.3) already reference executions via composite FK.
--
-- Monthly RANGE partitioning is applied to append-only audit_events.
-- executions and execution_steps stay unpartitioned so
-- UNIQUE (workspace_id, workflow_version_id, idempotency_key) and composite
-- FKs (including approvals) remain valid. retention_until + purge replace
-- monthly drops for those tables.

ALTER TABLE executions
    ADD COLUMN IF NOT EXISTS trigger_id uuid,
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint text,
    ADD COLUMN IF NOT EXISTS input_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS policy_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS correlation_id text,
    ADD COLUMN IF NOT EXISTS started_at timestamptz,
    ADD COLUMN IF NOT EXISTS finished_at timestamptz,
    ADD COLUMN IF NOT EXISTS retention_until timestamptz NOT NULL DEFAULT (now() + interval '90 days'),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check CHECK (status IN (
    'queued', 'pinned', 'running', 'succeeded', 'failed', 'canceled', 'indeterminate'
));

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_idempotency_key_len;
ALTER TABLE executions ADD CONSTRAINT executions_idempotency_key_len
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 1 AND 128);

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_idempotency_pair;
ALTER TABLE executions ADD CONSTRAINT executions_idempotency_pair
    CHECK (
        (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
        OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL
            AND idempotency_fingerprint ~ '^sha256:[0-9a-f]{64}$')
    );

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_input_obj;
ALTER TABLE executions ADD CONSTRAINT executions_input_obj
    CHECK (jsonb_typeof(input_redacted) = 'object');

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_policy_obj;
ALTER TABLE executions ADD CONSTRAINT executions_policy_obj
    CHECK (jsonb_typeof(policy_snapshot) = 'object');

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_correlation_len;
ALTER TABLE executions ADD CONSTRAINT executions_correlation_len
    CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 128);

CREATE UNIQUE INDEX IF NOT EXISTS executions_idempotency_uidx
    ON executions (workspace_id, workflow_version_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS executions_workspace_status_started_idx
    ON executions (workspace_id, status, started_at DESC NULLS LAST, created_at DESC);

CREATE OR REPLACE FUNCTION app.reject_execution_pin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.retention_until IS NOT NULL AND OLD.retention_until <= now() THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION 'execution version pins are immutable'
            USING ERRCODE = 'read_only_sql_transaction';
    END IF;
    IF NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
       OR NEW.workflow_digest IS DISTINCT FROM OLD.workflow_digest
       OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.idempotency_fingerprint IS DISTINCT FROM OLD.idempotency_fingerprint THEN
        RAISE EXCEPTION 'execution version pins are immutable'
            USING ERRCODE = 'read_only_sql_transaction';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TABLE execution_steps (
    workspace_id      uuid NOT NULL,
    id                uuid NOT NULL DEFAULT gen_random_uuid(),
    execution_id      uuid NOT NULL,
    node_id           text NOT NULL,
    node_type         text NOT NULL,
    attempt           integer NOT NULL DEFAULT 1,
    status            text NOT NULL DEFAULT 'queued',
    lease_id          uuid,
    fencing_token     bigint NOT NULL DEFAULT 0,
    idempotency_key   text,
    policy_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
    target_snapshot   jsonb NOT NULL DEFAULT '{}'::jsonb,
    input_redacted    jsonb NOT NULL DEFAULT '{}'::jsonb,
    output_redacted   jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_redacted    jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    finished_at       timestamptz,
    updated_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT execution_steps_execution_fk
        FOREIGN KEY (workspace_id, execution_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT execution_steps_attempt_unique
        UNIQUE (workspace_id, execution_id, node_id, attempt),
    CONSTRAINT execution_steps_attempt_positive CHECK (attempt >= 1),
    CONSTRAINT execution_steps_node_len CHECK (char_length(node_id) BETWEEN 1 AND 128),
    CONSTRAINT execution_steps_type_len CHECK (char_length(node_type) BETWEEN 1 AND 128),
    CONSTRAINT execution_steps_status_check CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed', 'canceled', 'indeterminate'
    )),
    CONSTRAINT execution_steps_fencing_nonneg CHECK (fencing_token >= 0),
    CONSTRAINT execution_steps_policy_obj CHECK (jsonb_typeof(policy_snapshot) = 'object'),
    CONSTRAINT execution_steps_target_obj CHECK (jsonb_typeof(target_snapshot) = 'object'),
    CONSTRAINT execution_steps_input_obj CHECK (jsonb_typeof(input_redacted) = 'object'),
    CONSTRAINT execution_steps_output_obj CHECK (jsonb_typeof(output_redacted) = 'object'),
    CONSTRAINT execution_steps_error_obj CHECK (jsonb_typeof(error_redacted) = 'object')
);

CREATE INDEX execution_steps_execution_node_idx
    ON execution_steps (workspace_id, execution_id, node_id);
CREATE INDEX execution_steps_id_idx ON execution_steps (id);

CREATE TABLE execution_jobs (
    workspace_id         uuid NOT NULL,
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    execution_id         uuid NOT NULL,
    execution_step_id    uuid NOT NULL,
    status               text NOT NULL DEFAULT 'queued',
    available_at         timestamptz NOT NULL DEFAULT now(),
    lease_expires_at     timestamptz,
    heartbeat_at         timestamptz,
    worker_id            text,
    fencing_token        bigint NOT NULL DEFAULT 0,
    attempt              integer NOT NULL DEFAULT 1,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT execution_jobs_execution_fk
        FOREIGN KEY (workspace_id, execution_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT execution_jobs_step_fk
        FOREIGN KEY (workspace_id, execution_step_id)
        REFERENCES execution_steps (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT execution_jobs_attempt_positive CHECK (attempt >= 1),
    CONSTRAINT execution_jobs_fencing_nonneg CHECK (fencing_token >= 0),
    CONSTRAINT execution_jobs_status_check CHECK (status IN (
        'queued', 'claimed', 'running', 'succeeded', 'failed', 'canceled', 'indeterminate'
    )),
    CONSTRAINT execution_jobs_worker_len CHECK (worker_id IS NULL OR char_length(worker_id) BETWEEN 1 AND 200)
);

CREATE INDEX execution_jobs_execution_idx
    ON execution_jobs (workspace_id, execution_id, created_at);
CREATE INDEX execution_jobs_step_idx
    ON execution_jobs (workspace_id, execution_step_id);
CREATE INDEX execution_jobs_id_idx ON execution_jobs (id);
CREATE INDEX execution_jobs_lease_idx
    ON execution_jobs (workspace_id, available_at, lease_expires_at)
    WHERE status IN ('queued', 'claimed', 'running');
CREATE UNIQUE INDEX execution_jobs_active_claim_idx
    ON execution_jobs (workspace_id, execution_step_id)
    WHERE status IN ('claimed', 'running');

CREATE TABLE audit_events (
    workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                      uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_id                uuid REFERENCES users (id),
    host_context_redacted   jsonb NOT NULL DEFAULT '{}'::jsonb,
    action                  text NOT NULL,
    resource_type           text NOT NULL,
    resource_id             uuid,
    outcome                 text NOT NULL,
    correlation_id          text,
    details_redacted        jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at             timestamptz NOT NULL DEFAULT now(),
    retention_until         timestamptz NOT NULL DEFAULT (now() + interval '365 days'),
    PRIMARY KEY (workspace_id, id, occurred_at),
    CONSTRAINT audit_events_action_len CHECK (char_length(action) BETWEEN 1 AND 128),
    CONSTRAINT audit_events_resource_type_len CHECK (char_length(resource_type) BETWEEN 1 AND 64),
    CONSTRAINT audit_events_outcome_len CHECK (char_length(outcome) BETWEEN 1 AND 64),
    CONSTRAINT audit_events_correlation_len CHECK (correlation_id IS NULL OR char_length(correlation_id) BETWEEN 1 AND 128),
    CONSTRAINT audit_events_host_obj CHECK (jsonb_typeof(host_context_redacted) = 'object'),
    CONSTRAINT audit_events_details_obj CHECK (jsonb_typeof(details_redacted) = 'object')
) PARTITION BY RANGE (occurred_at);

CREATE TABLE audit_events_2026_08 PARTITION OF audit_events
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE audit_events_2026_09 PARTITION OF audit_events
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE audit_events_2026_10 PARTITION OF audit_events
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE audit_events_2026_11 PARTITION OF audit_events
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE audit_events_2026_12 PARTITION OF audit_events
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE audit_events_2027_01 PARTITION OF audit_events
    FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
CREATE TABLE audit_events_2027_02 PARTITION OF audit_events
    FOR VALUES FROM ('2027-02-01') TO ('2027-03-01');
CREATE TABLE audit_events_2027_03 PARTITION OF audit_events
    FOR VALUES FROM ('2027-03-01') TO ('2027-04-01');
CREATE TABLE audit_events_default PARTITION OF audit_events DEFAULT;

CREATE INDEX audit_events_workspace_occurred_idx
    ON audit_events (workspace_id, occurred_at DESC);
CREATE INDEX audit_events_resource_idx
    ON audit_events (workspace_id, resource_type, resource_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION app.ensure_audit_month_partition(p_start date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    part_name text;
    p_end date;
BEGIN
    p_start := date_trunc('month', p_start)::date;
    p_end := (p_start + interval '1 month')::date;
    part_name := format('audit_events_%s', to_char(p_start, 'YYYY_MM'));
    IF to_regclass('public.' || part_name) IS NULL THEN
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF audit_events FOR VALUES FROM (%L) TO (%L)',
            part_name, p_start, p_end
        );
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.reject_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.retention_until IS NOT NULL AND OLD.retention_until <= now() THEN
            RETURN OLD;
        END IF;
    END IF;
    RAISE EXCEPTION 'audit events are append-only'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_audit_event_mutation();

SELECT app.enable_workspace_isolation('execution_steps');
SELECT app.enable_workspace_isolation('execution_jobs');
SELECT app.enable_workspace_isolation('audit_events');

GRANT SELECT, INSERT, UPDATE, DELETE ON executions TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON execution_steps TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON execution_jobs TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2026_08 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2026_09 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2026_10 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2026_11 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2026_12 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2027_01 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2027_02 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_2027_03 TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON audit_events_default TO flowforge_app;
