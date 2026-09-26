-- Approver groups are workspace-owned records. An empty group still has
-- a row, so a gate targeted at it can be rebuilt and stays pending.
-- Deleting the row is what makes that target unresolvable. Membership
-- lives in approver_group_members and can change without deleting the group.

CREATE TABLE approver_groups (
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id            uuid NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id)
);

CREATE TABLE approver_group_members (
    workspace_id  uuid NOT NULL,
    group_id      uuid NOT NULL,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, group_id, user_id),
    FOREIGN KEY (workspace_id, group_id) REFERENCES approver_groups (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX approver_group_members_user_idx ON approver_group_members (user_id);

SELECT app.enable_workspace_isolation('approver_groups');
SELECT app.enable_workspace_isolation('approver_group_members');

GRANT SELECT, INSERT, UPDATE, DELETE ON approver_groups TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON approver_group_members TO flowforge_app;
