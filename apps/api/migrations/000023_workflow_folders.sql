-- F.1: workspace-scoped workflow folders. Membership lives on
-- workflows.folder_id, never in YAML. FORCE RLS + composite FKs.
-- Delete of a folder never cascades to workflows (RESTRICT).

CREATE TABLE workflow_folders (
    workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    parent_id       uuid,
    name            text NOT NULL,
    created_by      uuid REFERENCES users (id),
    updated_by      uuid REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workflow_folders_parent_fk
        FOREIGN KEY (workspace_id, parent_id)
        REFERENCES workflow_folders (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT workflow_folders_name_len CHECK (char_length(name) BETWEEN 1 AND 256),
    CONSTRAINT workflow_folders_name_no_slash CHECK (position('/' in name) = 0)
);

-- Unique sibling names, case-insensitive. NULL parent_id is one sibling set.
CREATE UNIQUE INDEX workflow_folders_sibling_name_uidx
    ON workflow_folders (workspace_id, parent_id, lower(name))
    NULLS NOT DISTINCT;

CREATE INDEX workflow_folders_parent_idx
    ON workflow_folders (workspace_id, parent_id);

CREATE INDEX workflow_folders_id_idx ON workflow_folders (id);

ALTER TABLE workflows
    ADD COLUMN folder_id uuid;

ALTER TABLE workflows
    ADD CONSTRAINT workflows_folder_fk
        FOREIGN KEY (workspace_id, folder_id)
        REFERENCES workflow_folders (workspace_id, id)
        ON DELETE RESTRICT;

CREATE INDEX workflows_folder_idx
    ON workflows (workspace_id, folder_id);

SELECT app.enable_workspace_isolation('workflow_folders');
GRANT SELECT, INSERT, UPDATE, DELETE ON workflow_folders TO flowforge_app;
