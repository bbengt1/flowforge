-- E4.1: encrypted credential vault. Ciphertext only; FORCE RLS + composite FKs.
-- Isolation hook tables (workspace_records kind=credential) remain for E2.2.
-- Application requests never persist or return plaintext secret material.

CREATE TABLE credentials (
    workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    type                 text NOT NULL,
    display_name         text NOT NULL,
    ciphertext           bytea NOT NULL,
    dek_envelope         bytea NOT NULL,
    key_reference        text NOT NULL,
    encryption_version   integer NOT NULL DEFAULT 1,
    metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
    tags                 jsonb NOT NULL DEFAULT '[]'::jsonb,
    fingerprint          text NOT NULL,
    status               text NOT NULL DEFAULT 'active',
    last_test_status     text NOT NULL DEFAULT 'untested',
    last_tested_at       timestamptz,
    last_test_reason     text NOT NULL DEFAULT '',
    last_used_at         timestamptz,
    last_used_by         uuid REFERENCES users (id),
    use_count            bigint NOT NULL DEFAULT 0,
    rotated_at           timestamptz,
    expires_at           timestamptz,
    disabled_at          timestamptz,
    created_by           uuid REFERENCES users (id),
    updated_by           uuid REFERENCES users (id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT credentials_type_check CHECK (type IN (
        'kubernetes', 'ssh_private_key', 'token', 'webhook_secret', 'provider'
    )),
    CONSTRAINT credentials_status_check CHECK (status IN ('active', 'disabled')),
    CONSTRAINT credentials_test_status_check CHECK (last_test_status IN (
        'untested', 'passed', 'failed'
    )),
    CONSTRAINT credentials_name_len CHECK (char_length(display_name) BETWEEN 1 AND 200),
    CONSTRAINT credentials_key_ref_len CHECK (char_length(key_reference) BETWEEN 1 AND 200),
    CONSTRAINT credentials_fingerprint_format CHECK (fingerprint ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT credentials_encryption_version_check CHECK (encryption_version >= 1),
    CONSTRAINT credentials_use_count_check CHECK (use_count >= 0),
    CONSTRAINT credentials_test_reason_len CHECK (char_length(last_test_reason) <= 200),
    CONSTRAINT credentials_ciphertext_present CHECK (octet_length(ciphertext) > 0),
    CONSTRAINT credentials_dek_present CHECK (octet_length(dek_envelope) > 0)
);

CREATE INDEX credentials_workspace_updated_idx
    ON credentials (workspace_id, updated_at DESC);
CREATE INDEX credentials_workspace_status_idx
    ON credentials (workspace_id, status, display_name);
CREATE INDEX credentials_id_idx ON credentials (id);

CREATE TABLE credential_permissions (
    workspace_id    uuid NOT NULL,
    credential_id   uuid NOT NULL,
    principal_type  text NOT NULL,
    principal_id    uuid NOT NULL,
    permission      text NOT NULL,
    granted_by      uuid REFERENCES users (id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, credential_id, principal_type, principal_id, permission),
    CONSTRAINT credential_permissions_fk
        FOREIGN KEY (workspace_id, credential_id)
        REFERENCES credentials (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT credential_permissions_type_check CHECK (principal_type IN ('user', 'role')),
    CONSTRAINT credential_permissions_perm_check CHECK (permission IN ('use', 'rotate', 'manage'))
);

CREATE INDEX credential_permissions_principal_idx
    ON credential_permissions (workspace_id, principal_type, principal_id);

CREATE TABLE credential_events (
    workspace_id      uuid NOT NULL,
    id                uuid NOT NULL DEFAULT gen_random_uuid(),
    credential_id     uuid NOT NULL,
    event_type        text NOT NULL,
    actor_id          uuid REFERENCES users (id),
    details_redacted  jsonb NOT NULL DEFAULT '{}'::jsonb,
    occurred_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT credential_events_fk
        FOREIGN KEY (workspace_id, credential_id)
        REFERENCES credentials (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT credential_events_type_check CHECK (event_type IN (
        'created', 'rotated', 'disabled', 'enabled', 'tested',
        'used', 'metadata_updated', 'deleted'
    ))
);

CREATE INDEX credential_events_credential_idx
    ON credential_events (workspace_id, credential_id, occurred_at DESC);
CREATE INDEX credential_events_workspace_idx
    ON credential_events (workspace_id, occurred_at DESC);

SELECT app.enable_workspace_isolation('credentials');
SELECT app.enable_workspace_isolation('credential_permissions');
SELECT app.enable_workspace_isolation('credential_events');

CREATE OR REPLACE FUNCTION app.reject_credential_event_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'credential events are append-only'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

-- Events cannot be edited. Deletes are allowed only so credential
-- removal can cascade; the API never exposes event mutation.
CREATE TRIGGER credential_events_append_only
    BEFORE UPDATE ON credential_events
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_credential_event_update();

GRANT SELECT, INSERT, UPDATE, DELETE ON credentials TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON credential_permissions TO flowforge_app;
GRANT SELECT, INSERT, DELETE ON credential_events TO flowforge_app;
