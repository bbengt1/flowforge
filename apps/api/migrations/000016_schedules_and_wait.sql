-- E10.3: timezone-explicit schedules and durable flow.approval wait.
-- Schedules pin a published workflow version. Safe defaults are no
-- catch-up and skip-on-overlap. Waiting jobs hold no worker lease so
-- wait state survives pod loss. FORCE RLS + composite FKs.

CREATE TABLE workflow_schedules (
    workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    workflow_id          uuid NOT NULL,
    workflow_version_id  uuid NOT NULL,
    workflow_digest      text NOT NULL DEFAULT '',
    trigger_id           text NOT NULL DEFAULT '',
    timezone             text NOT NULL,
    cron                 text NOT NULL DEFAULT '',
    interval             text NOT NULL DEFAULT '',
    overlap_policy       text NOT NULL DEFAULT 'skip',
    misfire_policy       text NOT NULL DEFAULT 'ignore',
    catch_up             integer NOT NULL DEFAULT 0,
    status               text NOT NULL DEFAULT 'enabled',
    next_fire_at         timestamptz NOT NULL,
    last_fired_at        timestamptz,
    last_execution_id    uuid,
    last_error           text NOT NULL DEFAULT '',
    created_by           uuid REFERENCES users (id),
    updated_by           uuid REFERENCES users (id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workflow_schedules_workflow_fk
        FOREIGN KEY (workspace_id, workflow_id)
        REFERENCES workflows (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT workflow_schedules_version_fk
        FOREIGN KEY (workspace_id, workflow_version_id)
        REFERENCES workflow_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT workflow_schedules_execution_fk
        FOREIGN KEY (workspace_id, last_execution_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE SET NULL,
    CONSTRAINT workflow_schedules_status_check CHECK (status IN ('enabled', 'disabled')),
    CONSTRAINT workflow_schedules_overlap_check CHECK (overlap_policy IN ('skip', 'reject', 'queue')),
    CONSTRAINT workflow_schedules_misfire_check CHECK (misfire_policy IN ('ignore', 'fire-once')),
    CONSTRAINT workflow_schedules_catch_up_check CHECK (catch_up BETWEEN 0 AND 5),
    CONSTRAINT workflow_schedules_cron_xor_interval CHECK (
        (cron <> '' AND interval = '') OR (cron = '' AND interval <> '')
    ),
    CONSTRAINT workflow_schedules_timezone_len CHECK (char_length(timezone) BETWEEN 1 AND 64),
    CONSTRAINT workflow_schedules_cron_len CHECK (char_length(cron) <= 128),
    CONSTRAINT workflow_schedules_interval_len CHECK (char_length(interval) <= 32),
    CONSTRAINT workflow_schedules_trigger_len CHECK (char_length(trigger_id) <= 128),
    CONSTRAINT workflow_schedules_error_len CHECK (char_length(last_error) <= 500)
);

CREATE INDEX workflow_schedules_id_idx ON workflow_schedules (id);
CREATE INDEX workflow_schedules_workflow_idx
    ON workflow_schedules (workspace_id, workflow_id, created_at DESC);
CREATE INDEX workflow_schedules_due_idx
    ON workflow_schedules (workspace_id, next_fire_at)
    WHERE status = 'enabled';

SELECT app.enable_workspace_isolation('workflow_schedules');
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_schedules TO flowforge_app;

ALTER TABLE executions DROP CONSTRAINT IF EXISTS executions_status_check;
ALTER TABLE executions ADD CONSTRAINT executions_status_check CHECK (status IN (
    'queued', 'pinned', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'indeterminate'
));

ALTER TABLE execution_steps DROP CONSTRAINT IF EXISTS execution_steps_status_check;
ALTER TABLE execution_steps ADD CONSTRAINT execution_steps_status_check CHECK (status IN (
    'queued', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'indeterminate'
));

ALTER TABLE execution_jobs DROP CONSTRAINT IF EXISTS execution_jobs_status_check;
ALTER TABLE execution_jobs ADD CONSTRAINT execution_jobs_status_check CHECK (status IN (
    'queued', 'claimed', 'running', 'waiting', 'succeeded', 'failed', 'canceled', 'indeterminate'
));
