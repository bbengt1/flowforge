-- G.1.6: machine / service principals for scrapers and automation.
-- Identity substrate (like local_logins): no workspace RLS. Secret
-- hashes and assertion public keys are never selected into API views.
-- Grants are explicit rows; an empty set authorizes nothing.

INSERT INTO permissions (key) VALUES
    ('ops.metrics.read')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE machine_principals (
    id                    uuid PRIMARY KEY,
    user_id               uuid NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    client_id             text NOT NULL,
    display_name          text NOT NULL,
    secret_hash           text NOT NULL DEFAULT '',
    assertion_public_key  bytea,
    status                text NOT NULL DEFAULT 'active',
    tenant_id             uuid REFERENCES tenants (id),
    workspace_id          uuid REFERENCES workspaces (id),
    workbench_key         text NOT NULL DEFAULT '',
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    rotated_at            timestamptz,
    revoked_at            timestamptz,
    CONSTRAINT machine_principals_client_id_unique UNIQUE (client_id),
    CONSTRAINT machine_principals_client_id_format CHECK (client_id ~ '^[a-z][a-z0-9._-]{1,63}$'),
    CONSTRAINT machine_principals_display_len CHECK (char_length(display_name) BETWEEN 1 AND 200),
    CONSTRAINT machine_principals_hash_len CHECK (char_length(secret_hash) <= 255),
    CONSTRAINT machine_principals_status_check CHECK (status IN ('active', 'revoked')),
    CONSTRAINT machine_principals_workbench_len CHECK (char_length(workbench_key) <= 64),
    CONSTRAINT machine_principals_factor CHECK (
        char_length(secret_hash) > 0 OR assertion_public_key IS NOT NULL
    ),
    CONSTRAINT machine_principals_pubkey_len CHECK (
        assertion_public_key IS NULL OR octet_length(assertion_public_key) = 32
    )
);

CREATE INDEX machine_principals_status_idx ON machine_principals (status);

CREATE TABLE machine_principal_grants (
    principal_id    uuid NOT NULL REFERENCES machine_principals (id) ON DELETE CASCADE,
    permission_key  text NOT NULL,
    PRIMARY KEY (principal_id, permission_key),
    CONSTRAINT machine_principal_grants_key_len CHECK (char_length(permission_key) BETWEEN 1 AND 128)
);

CREATE TABLE machine_assertion_jti (
    jti           text PRIMARY KEY,
    client_id     text NOT NULL,
    retain_until  timestamptz NOT NULL,
    CONSTRAINT machine_assertion_jti_len CHECK (char_length(jti) BETWEEN 16 AND 128)
);

CREATE INDEX machine_assertion_jti_retain_idx ON machine_assertion_jti (retain_until);

GRANT SELECT, INSERT, UPDATE, DELETE ON machine_principals TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON machine_principal_grants TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON machine_assertion_jti TO flowforge_app;
