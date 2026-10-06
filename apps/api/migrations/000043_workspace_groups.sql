-- Workspace groups (#564). 000043 belongs to #564; #557 took no
-- migration. Groups exist only to target approvals. They never grant a
-- permission, and membership never grants approval.decide. No nested
-- groups, roles, email, or SCIM columns. Both tables use FORCE RLS via
-- the isolation helper. Deleting a group is a hard delete that cascades
-- to its member rows. Schema migrations are forward-only, so this file
-- has no down script. Audit actions need no schema change because
-- audit_events.action has a length check only.

CREATE TABLE workspace_groups (
    workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    display_name    text NOT NULL,
    created_by      uuid REFERENCES users (id),
    updated_by      uuid REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT workspace_groups_display_name_len
        CHECK (char_length(display_name) BETWEEN 1 AND 128),
    CONSTRAINT workspace_groups_display_name_trimmed
        CHECK (display_name = btrim(display_name))
);

-- One name per workspace without regard to case. The API maps a
-- violation of this index to 409 group_name_taken.
CREATE UNIQUE INDEX workspace_groups_name_uidx
    ON workspace_groups (workspace_id, lower(display_name));

CREATE TABLE workspace_group_members (
    workspace_id    uuid NOT NULL,
    group_id        uuid NOT NULL,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    added_by        uuid REFERENCES users (id),
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, group_id, user_id),
    CONSTRAINT workspace_group_members_group_fk
        FOREIGN KEY (workspace_id, group_id)
        REFERENCES workspace_groups (workspace_id, id)
        ON DELETE CASCADE
);

-- Removing a user from a workspace deletes their rows by (workspace, user).
CREATE INDEX workspace_group_members_user_idx
    ON workspace_group_members (workspace_id, user_id);

SELECT app.enable_workspace_isolation('workspace_groups');
SELECT app.enable_workspace_isolation('workspace_group_members');

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_groups TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_group_members TO flowforge_app;
