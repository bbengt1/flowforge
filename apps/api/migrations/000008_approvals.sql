-- E4.3: policy-bound approval requirements.
-- Approvals pin workflow version, target revision, policy revision,
-- operation, and expiry. A later publish of the bound target/policy
-- invalidates pending and approved rows. Decisions recheck authorization.

CREATE TABLE approvals (
    workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    workflow_id          uuid NOT NULL,
    workflow_version_id  uuid NOT NULL,
    workflow_digest      text NOT NULL,
    execution_id         uuid,
    node_id              text NOT NULL,
    node_name            text NOT NULL DEFAULT '',
    operation            text NOT NULL,
    target_kind          text NOT NULL DEFAULT '',
    target_id            uuid,
    target_version_id    uuid,
    target_digest        text NOT NULL DEFAULT '',
    policy_resource_id   uuid,
    policy_version_id    uuid,
    policy_digest        text NOT NULL DEFAULT '',
    policy_revision      integer NOT NULL DEFAULT 0,
    binding_fingerprint  text NOT NULL,
    approver_role        text NOT NULL DEFAULT 'approver',
    status               text NOT NULL DEFAULT 'pending',
    expires_at           timestamptz NOT NULL,
    requested_by         uuid REFERENCES users (id),
    decided_by           uuid REFERENCES users (id),
    decided_at           timestamptz,
    decision_note        text NOT NULL DEFAULT '',
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT approvals_workflow_fk
        FOREIGN KEY (workspace_id, workflow_id)
        REFERENCES workflows (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT approvals_version_fk
        FOREIGN KEY (workspace_id, workflow_version_id)
        REFERENCES workflow_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT approvals_execution_fk
        FOREIGN KEY (workspace_id, execution_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE SET NULL,
    CONSTRAINT approvals_target_fk
        FOREIGN KEY (workspace_id, target_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT approvals_target_version_fk
        FOREIGN KEY (workspace_id, target_version_id)
        REFERENCES ops_resource_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT approvals_policy_resource_fk
        FOREIGN KEY (workspace_id, policy_resource_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT approvals_policy_version_fk
        FOREIGN KEY (workspace_id, policy_version_id)
        REFERENCES ops_resource_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT approvals_status_check CHECK (status IN (
        'pending', 'approved', 'rejected', 'expired', 'invalidated'
    )),
    CONSTRAINT approvals_digest_format CHECK (workflow_digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT approvals_fingerprint_format CHECK (binding_fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT approvals_node_len CHECK (char_length(node_id) BETWEEN 1 AND 128),
    CONSTRAINT approvals_operation_len CHECK (char_length(operation) BETWEEN 1 AND 128),
    CONSTRAINT approvals_role_len CHECK (char_length(approver_role) BETWEEN 1 AND 64),
    CONSTRAINT approvals_note_len CHECK (char_length(decision_note) <= 2000),
    CONSTRAINT approvals_revision_nonneg CHECK (policy_revision >= 0)
);

CREATE INDEX approvals_workspace_status_idx
    ON approvals (workspace_id, status, created_at DESC);
CREATE INDEX approvals_version_idx
    ON approvals (workspace_id, workflow_version_id, created_at DESC);
CREATE INDEX approvals_id_idx ON approvals (id);

CREATE UNIQUE INDEX approvals_active_fingerprint_idx
    ON approvals (workspace_id, binding_fingerprint)
    WHERE status IN ('pending', 'approved');

CREATE TABLE approval_events (
    workspace_id    uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    approval_id     uuid NOT NULL,
    event_type      text NOT NULL,
    actor_id        uuid REFERENCES users (id),
    details         jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT approval_events_fk
        FOREIGN KEY (workspace_id, approval_id)
        REFERENCES approvals (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT approval_events_type_check CHECK (event_type IN (
        'created', 'approved', 'rejected', 'expired', 'invalidated'
    )),
    CONSTRAINT approval_events_details_obj CHECK (jsonb_typeof(details) = 'object')
);

CREATE INDEX approval_events_approval_idx
    ON approval_events (workspace_id, approval_id, occurred_at DESC);

SELECT app.enable_workspace_isolation('approvals');
SELECT app.enable_workspace_isolation('approval_events');

CREATE OR REPLACE FUNCTION app.reject_approval_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'approval events are append-only'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

CREATE TRIGGER approval_events_immutable
    BEFORE UPDATE OR DELETE ON approval_events
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_approval_event_mutation();

GRANT SELECT, INSERT, UPDATE ON approvals TO flowforge_app;
GRANT SELECT, INSERT ON approval_events TO flowforge_app;
