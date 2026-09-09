-- E9.1: content-addressed script artifacts and workflow-version pins.
-- Runtime profiles remain ops_resources kind=runtime_profile (E4.2).
-- Isolated runners (E9.2), typed I/O (E9.3), and revocation (E9.4) are hooks only.

CREATE TABLE script_artifacts (
    workspace_id                 uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                           uuid NOT NULL DEFAULT gen_random_uuid(),
    language                     text NOT NULL,
    entrypoint                   text NOT NULL,
    digest                       text NOT NULL,
    signature                    text NOT NULL,
    scan_status                  text NOT NULL,
    status                       text NOT NULL DEFAULT 'published',
    runtime_profile_id           uuid,
    runtime_profile_version_id   uuid,
    runtime_profile_digest       text,
    source_bytes                 integer NOT NULL,
    metadata                     jsonb NOT NULL DEFAULT '{}'::jsonb,
    storage_ref                  text NOT NULL,
    package_blob                 bytea,
    created_by                   uuid REFERENCES users (id),
    created_at                   timestamptz NOT NULL DEFAULT now(),
    revoked_at                   timestamptz,
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT script_artifacts_language_check CHECK (language IN ('python', 'go')),
    CONSTRAINT script_artifacts_status_check CHECK (status IN ('draft', 'published')),
    CONSTRAINT script_artifacts_scan_check CHECK (scan_status IN ('pending', 'clean', 'failed', 'unsigned')),
    CONSTRAINT script_artifacts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT script_artifacts_profile_digest_format CHECK (
        runtime_profile_digest IS NULL OR runtime_profile_digest ~ '^sha256:[0-9a-f]{64}$'
    ),
    CONSTRAINT script_artifacts_signature_len CHECK (char_length(signature) BETWEEN 0 AND 200),
    CONSTRAINT script_artifacts_entrypoint_len CHECK (char_length(entrypoint) BETWEEN 1 AND 256),
    CONSTRAINT script_artifacts_source_bytes CHECK (source_bytes BETWEEN 1 AND 65536),
    CONSTRAINT script_artifacts_storage_len CHECK (char_length(storage_ref) BETWEEN 8 AND 200),
    CONSTRAINT script_artifacts_metadata_obj CHECK (jsonb_typeof(metadata) = 'object'),
    CONSTRAINT script_artifacts_digest_unique UNIQUE (workspace_id, digest)
);

CREATE INDEX script_artifacts_id_idx ON script_artifacts (id);
CREATE INDEX script_artifacts_workspace_idx
    ON script_artifacts (workspace_id, created_at DESC);

CREATE TABLE workflow_version_artifacts (
    workspace_id         uuid NOT NULL,
    workflow_version_id  uuid NOT NULL,
    node_id              text NOT NULL,
    node_type            text NOT NULL DEFAULT '',
    script_artifact_id   uuid NOT NULL,
    digest               text NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, workflow_version_id, node_id),
    CONSTRAINT workflow_version_artifacts_version_fk
        FOREIGN KEY (workspace_id, workflow_version_id)
        REFERENCES workflow_versions (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT workflow_version_artifacts_artifact_fk
        FOREIGN KEY (workspace_id, script_artifact_id)
        REFERENCES script_artifacts (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT workflow_version_artifacts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT workflow_version_artifacts_node_id CHECK (node_id ~ '^[a-z][a-z0-9-]{0,62}$')
);

CREATE INDEX workflow_version_artifacts_version_idx
    ON workflow_version_artifacts (workspace_id, workflow_version_id);
CREATE INDEX workflow_version_artifacts_artifact_idx
    ON workflow_version_artifacts (workspace_id, script_artifact_id);

SELECT app.enable_workspace_isolation('script_artifacts');
SELECT app.enable_workspace_isolation('workflow_version_artifacts');

GRANT SELECT, INSERT ON script_artifacts TO flowforge_app;
GRANT SELECT, INSERT ON workflow_version_artifacts TO flowforge_app;

-- Published artifacts are immutable. revoked_at is reserved for E9.4.
CREATE OR REPLACE FUNCTION app.reject_immutable_script_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.digest IS DISTINCT FROM OLD.digest
            OR NEW.signature IS DISTINCT FROM OLD.signature
            OR NEW.package_blob IS DISTINCT FROM OLD.package_blob
            OR NEW.language IS DISTINCT FROM OLD.language
            OR NEW.entrypoint IS DISTINCT FROM OLD.entrypoint
            OR NEW.storage_ref IS DISTINCT FROM OLD.storage_ref THEN
            RAISE EXCEPTION 'script artifacts are immutable'
                USING ERRCODE = 'read_only_sql_transaction';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'script artifacts are immutable'
            USING ERRCODE = 'read_only_sql_transaction';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER script_artifacts_immutable
    BEFORE UPDATE OR DELETE ON script_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_immutable_script_artifact();

CREATE OR REPLACE FUNCTION app.reject_immutable_workflow_version_artifact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'workflow version script pins are immutable'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

CREATE TRIGGER workflow_version_artifacts_immutable
    BEFORE UPDATE OR DELETE ON workflow_version_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_immutable_workflow_version_artifact();

INSERT INTO permissions (key) VALUES
    ('script.run')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('operator', 'script.run'),
    ('admin', 'script.run')
)
ON CONFLICT DO NOTHING;
