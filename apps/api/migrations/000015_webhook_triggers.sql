-- E10.2: replay-safe webhook triggers.
-- Opaque public IDs live outside YAML. Secrets stay in the vault
-- (type webhook_secret). Replay identifiers are retained for at least
-- the configured clock-skew window. FORCE RLS + composite FKs.

CREATE TABLE workflow_triggers (
    workspace_id              uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                        uuid NOT NULL DEFAULT gen_random_uuid(),
    public_id                 text NOT NULL,
    workflow_id               uuid NOT NULL,
    workflow_version_id       uuid NOT NULL,
    type                      text NOT NULL,
    status                    text NOT NULL DEFAULT 'enabled',
    secret_credential_id      uuid NOT NULL,
    content_type              text NOT NULL DEFAULT 'application/json',
    field_mapping             jsonb NOT NULL DEFAULT '{}'::jsonb,
    max_body_bytes            integer NOT NULL DEFAULT 65536,
    clock_skew_seconds        integer NOT NULL DEFAULT 300,
    replay_retention_seconds  integer NOT NULL DEFAULT 600,
    rate_limit_per_minute     integer NOT NULL DEFAULT 60,
    workspace_rate_per_minute integer NOT NULL DEFAULT 300,
    max_concurrency           integer NOT NULL DEFAULT 5,
    workspace_max_concurrency integer NOT NULL DEFAULT 20,
    created_by                uuid REFERENCES users (id),
    updated_by                uuid REFERENCES users (id),
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workflow_triggers_workflow_fk
        FOREIGN KEY (workspace_id, workflow_id)
        REFERENCES workflows (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT workflow_triggers_version_fk
        FOREIGN KEY (workspace_id, workflow_version_id)
        REFERENCES workflow_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT workflow_triggers_secret_fk
        FOREIGN KEY (workspace_id, secret_credential_id)
        REFERENCES credentials (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT workflow_triggers_type_check CHECK (type = 'webhook'),
    CONSTRAINT workflow_triggers_status_check CHECK (status IN ('enabled', 'disabled')),
    CONSTRAINT workflow_triggers_public_id_format
        CHECK (public_id ~ '^wh_[0-9a-f]{64}$'),
    CONSTRAINT workflow_triggers_content_type_len
        CHECK (char_length(content_type) BETWEEN 1 AND 128),
    CONSTRAINT workflow_triggers_mapping_obj
        CHECK (jsonb_typeof(field_mapping) = 'object'),
    CONSTRAINT workflow_triggers_max_body_check
        CHECK (max_body_bytes BETWEEN 1 AND 262144),
    CONSTRAINT workflow_triggers_skew_check
        CHECK (clock_skew_seconds BETWEEN 1 AND 3600),
    CONSTRAINT workflow_triggers_replay_check
        CHECK (replay_retention_seconds BETWEEN clock_skew_seconds AND 7200),
    CONSTRAINT workflow_triggers_rate_check
        CHECK (rate_limit_per_minute BETWEEN 1 AND 600),
    CONSTRAINT workflow_triggers_ws_rate_check
        CHECK (workspace_rate_per_minute BETWEEN 1 AND 3000),
    CONSTRAINT workflow_triggers_conc_check
        CHECK (max_concurrency BETWEEN 1 AND 20),
    CONSTRAINT workflow_triggers_ws_conc_check
        CHECK (workspace_max_concurrency BETWEEN 1 AND 100)
);

CREATE UNIQUE INDEX workflow_triggers_public_id_uidx
    ON workflow_triggers (public_id);
CREATE INDEX workflow_triggers_id_idx ON workflow_triggers (id);
CREATE INDEX workflow_triggers_workflow_idx
    ON workflow_triggers (workspace_id, workflow_id, created_at DESC);
CREATE INDEX workflow_triggers_secret_idx
    ON workflow_triggers (workspace_id, secret_credential_id);

CREATE TABLE webhook_replays (
    workspace_id  uuid NOT NULL,
    trigger_id    uuid NOT NULL,
    replay_id     text NOT NULL,
    expires_at    timestamptz NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, trigger_id, replay_id),
    CONSTRAINT webhook_replays_trigger_fk
        FOREIGN KEY (workspace_id, trigger_id)
        REFERENCES workflow_triggers (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT webhook_replays_id_format
        CHECK (replay_id ~ '^[0-9a-f]{64}$'),
    CONSTRAINT webhook_replays_id_len
        CHECK (char_length(replay_id) = 64)
);

CREATE INDEX webhook_replays_expires_idx
    ON webhook_replays (workspace_id, expires_at);

CREATE TABLE webhook_rate_windows (
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    scope_kind    text NOT NULL,
    scope_id      text NOT NULL,
    window_start  timestamptz NOT NULL,
    count         integer NOT NULL DEFAULT 0,
    in_flight     integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, scope_kind, scope_id, window_start),
    CONSTRAINT webhook_rate_kind_check CHECK (scope_kind IN ('trigger', 'workspace')),
    CONSTRAINT webhook_rate_count_check CHECK (count >= 0),
    CONSTRAINT webhook_rate_inflight_check CHECK (in_flight >= 0)
);

SELECT app.enable_workspace_isolation('workflow_triggers');
SELECT app.enable_workspace_isolation('webhook_replays');
SELECT app.enable_workspace_isolation('webhook_rate_windows');

-- Resolve an opaque public ID to a workspace without requiring prior scope.
-- Returns NULL when the ID is unknown. RLS still applies to subsequent reads.
CREATE OR REPLACE FUNCTION app.lookup_webhook_workspace(p_public_id text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app
AS $$
DECLARE
    ws uuid;
BEGIN
    SELECT workspace_id INTO ws
    FROM workflow_triggers
    WHERE public_id = p_public_id;
    RETURN ws;
END;
$$;

REVOKE ALL ON FUNCTION app.lookup_webhook_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lookup_webhook_workspace(text) TO flowforge_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_triggers TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_replays TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_rate_windows TO flowforge_app;
