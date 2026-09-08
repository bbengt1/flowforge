-- E3.2: workflows, mutable drafts, immutable versions, and pinned execution stubs.
-- Workspace-owned tables use FORCE RLS and composite (workspace_id, id) keys.
-- Application requests persist normalized YAML only; versions cannot be updated.

CREATE TABLE workflows (
    workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    slug            text NOT NULL,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'draft',
    draft_revision  bigint NOT NULL DEFAULT 0,
    created_by      uuid REFERENCES users (id),
    updated_by      uuid REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workflows_slug_unique UNIQUE (workspace_id, slug),
    CONSTRAINT workflows_slug_format CHECK (slug ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT workflows_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT workflows_status_check CHECK (status IN ('draft', 'published', 'archived')),
    CONSTRAINT workflows_draft_revision_check CHECK (draft_revision >= 0)
);

CREATE INDEX workflows_workspace_updated_idx
    ON workflows (workspace_id, updated_at DESC);
CREATE INDEX workflows_id_idx ON workflows (id);

CREATE TABLE workflow_drafts (
    workspace_id        uuid NOT NULL,
    workflow_id         uuid NOT NULL,
    normalized_yaml     text NOT NULL,
    definition_digest   text NOT NULL,
    parsed_definition   jsonb NOT NULL,
    validation_state    text NOT NULL DEFAULT 'valid',
    revision            bigint NOT NULL,
    updated_by          uuid REFERENCES users (id),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, workflow_id),
    CONSTRAINT workflow_drafts_workflow_fk
        FOREIGN KEY (workspace_id, workflow_id)
        REFERENCES workflows (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT workflow_drafts_revision_positive CHECK (revision >= 1),
    CONSTRAINT workflow_drafts_digest_format CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT workflow_drafts_yaml_len CHECK (char_length(normalized_yaml) BETWEEN 1 AND 262144),
    CONSTRAINT workflow_drafts_validation_check CHECK (validation_state IN ('valid', 'invalid'))
);

CREATE INDEX workflow_drafts_digest_idx
    ON workflow_drafts (workspace_id, definition_digest);

CREATE TABLE workflow_versions (
    workspace_id        uuid NOT NULL,
    id                  uuid NOT NULL DEFAULT gen_random_uuid(),
    workflow_id         uuid NOT NULL,
    version_number      integer NOT NULL,
    normalized_yaml     text NOT NULL,
    definition_digest   text NOT NULL,
    parsed_definition   jsonb NOT NULL,
    publish_note        text NOT NULL DEFAULT '',
    published_by        uuid REFERENCES users (id),
    published_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workflow_versions_workflow_fk
        FOREIGN KEY (workspace_id, workflow_id)
        REFERENCES workflows (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT workflow_versions_number_unique UNIQUE (workspace_id, workflow_id, version_number),
    CONSTRAINT workflow_versions_digest_unique UNIQUE (workspace_id, workflow_id, definition_digest),
    CONSTRAINT workflow_versions_number_positive CHECK (version_number >= 1),
    CONSTRAINT workflow_versions_digest_format CHECK (definition_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT workflow_versions_yaml_len CHECK (char_length(normalized_yaml) BETWEEN 1 AND 262144),
    CONSTRAINT workflow_versions_note_len CHECK (char_length(publish_note) <= 2000)
);

CREATE INDEX workflow_versions_workflow_idx
    ON workflow_versions (workspace_id, workflow_id, version_number DESC);
CREATE INDEX workflow_versions_id_idx ON workflow_versions (id);

-- Stub execution rows for E3.2 pinning. E5 extends this table; version/digest
-- remain immutable after insert so later draft edits cannot retarget a run.
CREATE TABLE executions (
    workspace_id         uuid NOT NULL,
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    workflow_id          uuid NOT NULL,
    workflow_version_id  uuid NOT NULL,
    workflow_digest      text NOT NULL,
    status               text NOT NULL DEFAULT 'queued',
    requested_by         uuid REFERENCES users (id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT executions_workflow_fk
        FOREIGN KEY (workspace_id, workflow_id)
        REFERENCES workflows (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT executions_version_fk
        FOREIGN KEY (workspace_id, workflow_version_id)
        REFERENCES workflow_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT executions_digest_format CHECK (workflow_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT executions_status_check CHECK (status IN ('queued', 'pinned'))
);

CREATE INDEX executions_workflow_idx
    ON executions (workspace_id, workflow_id, created_at DESC);
CREATE INDEX executions_id_idx ON executions (id);

SELECT app.enable_workspace_isolation('workflows');
SELECT app.enable_workspace_isolation('workflow_drafts');
SELECT app.enable_workspace_isolation('workflow_versions');
SELECT app.enable_workspace_isolation('executions');

CREATE OR REPLACE FUNCTION app.reject_immutable_workflow_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'workflow versions are immutable'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

CREATE TRIGGER workflow_versions_immutable
    BEFORE UPDATE OR DELETE ON workflow_versions
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_immutable_workflow_version();

CREATE OR REPLACE FUNCTION app.reject_execution_pin_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'execution version pins are immutable'
            USING ERRCODE = 'read_only_sql_transaction';
    END IF;
    IF NEW.workflow_version_id IS DISTINCT FROM OLD.workflow_version_id
       OR NEW.workflow_digest IS DISTINCT FROM OLD.workflow_digest
       OR NEW.workflow_id IS DISTINCT FROM OLD.workflow_id THEN
        RAISE EXCEPTION 'execution version pins are immutable'
            USING ERRCODE = 'read_only_sql_transaction';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER executions_pin_immutable
    BEFORE UPDATE OR DELETE ON executions
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_execution_pin_mutation();

GRANT SELECT, INSERT, UPDATE, DELETE ON workflows TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_drafts TO flowforge_app;
GRANT SELECT, INSERT ON workflow_versions TO flowforge_app;
GRANT SELECT, INSERT ON executions TO flowforge_app;
