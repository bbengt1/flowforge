-- Approver targeting for flow.approval gates. 000044 belongs to this
-- story. A gate's with.approvers names users and workspace groups by
-- UUID. approvers_digest is the authority on whether a row is targeted:
-- '' keeps today's untargeted behavior, a non-empty value is sha256 over
-- the sorted named users and groups and is part of the binding
-- fingerprint. A targeted row whose snapshot rows are all gone can be
-- decided by nobody but a non-requester admin override, never by
-- everyone. The user snapshot holds the named users who were eligible at
-- park. The group snapshot holds group ids only; membership is read live
-- at decide time and member rows are never copied here. Both tables use
-- FORCE RLS via the isolation helper and need no BYPASSRLS. Schema
-- migrations are forward-only, so this file has no down script.

ALTER TABLE approvals ADD COLUMN approvers_digest text NOT NULL DEFAULT '';

CREATE TABLE approval_approver_users (
    workspace_id    uuid NOT NULL,
    approval_id     uuid NOT NULL,
    user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, approval_id, user_id),
    CONSTRAINT approval_approver_users_approval_fk
        FOREIGN KEY (workspace_id, approval_id)
        REFERENCES approvals (workspace_id, id)
        ON DELETE CASCADE
);

CREATE INDEX approval_approver_users_user_idx
    ON approval_approver_users (workspace_id, user_id);

CREATE TABLE approval_approver_groups (
    workspace_id    uuid NOT NULL,
    approval_id     uuid NOT NULL,
    group_id        uuid NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, approval_id, group_id),
    CONSTRAINT approval_approver_groups_approval_fk
        FOREIGN KEY (workspace_id, approval_id)
        REFERENCES approvals (workspace_id, id)
        ON DELETE CASCADE,
    -- Deleting a group removes it from every snapshot. The row stays
    -- targeted (approvers_digest), so it fails closed.
    CONSTRAINT approval_approver_groups_group_fk
        FOREIGN KEY (workspace_id, group_id)
        REFERENCES workspace_groups (workspace_id, id)
        ON DELETE CASCADE
);

CREATE INDEX approval_approver_groups_group_idx
    ON approval_approver_groups (workspace_id, group_id);

SELECT app.enable_workspace_isolation('approval_approver_users');
SELECT app.enable_workspace_isolation('approval_approver_groups');

-- DELETE is for the boot resync snapshot rewrite.
GRANT SELECT, INSERT, DELETE ON approval_approver_users TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON approval_approver_groups TO flowforge_app;
