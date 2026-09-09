-- E5.3: encrypted execution artifact metadata, short-lived download grants,
-- and legal-hold columns. Object payloads live in the configured store
-- (local MVP: filesystem under ARTIFACT_STORE_DIR) encrypted at rest.
-- storage_ref is an opaque server-generated locator, never a client URL.

CREATE TABLE execution_artifacts (
    workspace_id            uuid NOT NULL,
    id                      uuid NOT NULL DEFAULT gen_random_uuid(),
    execution_id            uuid NOT NULL,
    execution_step_id       uuid,
    kind                    text NOT NULL,
    filename                text NOT NULL DEFAULT '',
    content_type            text NOT NULL DEFAULT 'application/octet-stream',
    storage_ref             text NOT NULL,
    digest                  text NOT NULL,
    size_bytes              bigint NOT NULL,
    content_classification  text NOT NULL,
    redacted                boolean NOT NULL DEFAULT true,
    expires_at              timestamptz NOT NULL,
    metadata_ciphertext     bytea NOT NULL,
    dek_envelope            bytea NOT NULL,
    key_reference           text NOT NULL,
    encryption_version      integer NOT NULL DEFAULT 1,
    legal_hold              boolean NOT NULL DEFAULT false,
    legal_hold_reason       text NOT NULL DEFAULT '',
    legal_hold_by           uuid,
    legal_hold_at           timestamptz,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT execution_artifacts_execution_fk
        FOREIGN KEY (workspace_id, execution_id)
        REFERENCES executions (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT execution_artifacts_step_fk
        FOREIGN KEY (workspace_id, execution_step_id)
        REFERENCES execution_steps (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT execution_artifacts_kind_check CHECK (kind IN ('log', 'output', 'file')),
    CONSTRAINT execution_artifacts_filename_len CHECK (char_length(filename) BETWEEN 0 AND 128),
    CONSTRAINT execution_artifacts_type_len CHECK (char_length(content_type) BETWEEN 1 AND 128),
    CONSTRAINT execution_artifacts_storage_len CHECK (char_length(storage_ref) BETWEEN 8 AND 200),
    CONSTRAINT execution_artifacts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT execution_artifacts_size_nonneg CHECK (size_bytes >= 0),
    CONSTRAINT execution_artifacts_class_check CHECK (content_classification IN ('public', 'internal', 'confidential')),
    CONSTRAINT execution_artifacts_enc_ver CHECK (encryption_version >= 1),
    CONSTRAINT execution_artifacts_key_len CHECK (char_length(key_reference) BETWEEN 1 AND 200),
    CONSTRAINT execution_artifacts_hold_reason_len CHECK (char_length(legal_hold_reason) <= 512),
    CONSTRAINT execution_artifacts_storage_unique UNIQUE (workspace_id, storage_ref)
);

CREATE INDEX execution_artifacts_execution_idx
    ON execution_artifacts (workspace_id, execution_id, created_at);
CREATE INDEX execution_artifacts_step_idx
    ON execution_artifacts (workspace_id, execution_step_id, created_at)
    WHERE execution_step_id IS NOT NULL;
CREATE INDEX execution_artifacts_id_idx ON execution_artifacts (id);
CREATE INDEX execution_artifacts_expiry_idx
    ON execution_artifacts (workspace_id, expires_at)
    WHERE legal_hold = false;

CREATE TABLE artifact_download_grants (
    workspace_id    uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    artifact_id     uuid NOT NULL,
    actor_id        uuid,
    expires_at      timestamptz NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT artifact_download_grants_artifact_fk
        FOREIGN KEY (workspace_id, artifact_id)
        REFERENCES execution_artifacts (workspace_id, id)
        ON DELETE CASCADE
);

CREATE INDEX artifact_download_grants_artifact_idx
    ON artifact_download_grants (workspace_id, artifact_id, expires_at);
CREATE INDEX artifact_download_grants_id_idx ON artifact_download_grants (id);
CREATE INDEX artifact_download_grants_expiry_idx
    ON artifact_download_grants (expires_at);

SELECT app.enable_workspace_isolation('execution_artifacts');
SELECT app.enable_workspace_isolation('artifact_download_grants');

GRANT SELECT, INSERT, UPDATE, DELETE ON execution_artifacts TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON artifact_download_grants TO flowforge_app;
