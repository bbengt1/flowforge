-- G.2.1 / #446: OIDC Authorization Code + PKCE transactions and TOTP
-- step-up. Identity substrate (like local_logins and browser_sessions):
-- no workspace RLS. Verifiers and TOTP secrets are ciphertext only.
-- The client secret is never stored here.

ALTER TABLE browser_sessions
    ADD COLUMN auth_method text NOT NULL DEFAULT '',
    ADD COLUMN mfa_verified_at timestamptz,
    ADD CONSTRAINT browser_sessions_auth_method_check CHECK (
        auth_method IN ('', 'local-login', 'oidc', 'machine', 'trusted-dev', 'embed')
    );

CREATE TABLE oidc_auth_transactions (
    id                    uuid PRIMARY KEY,
    state_hash            bytea NOT NULL,
    verifier_ciphertext   bytea NOT NULL,
    nonce                 text NOT NULL,
    expires_at            timestamptz NOT NULL,
    consumed_at           timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT oidc_auth_transactions_state_hash_len CHECK (octet_length(state_hash) = 32),
    CONSTRAINT oidc_auth_transactions_nonce_len CHECK (char_length(nonce) BETWEEN 16 AND 128),
    CONSTRAINT oidc_auth_transactions_cipher_len CHECK (octet_length(verifier_ciphertext) BETWEEN 32 AND 512)
);

CREATE UNIQUE INDEX oidc_auth_transactions_state_hash_idx
    ON oidc_auth_transactions (state_hash);

CREATE INDEX oidc_auth_transactions_expires_idx
    ON oidc_auth_transactions (expires_at);

CREATE TABLE user_mfa_totp (
    user_id              uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    secret_ciphertext    bytea NOT NULL,
    confirmed_at         timestamptz,
    last_step            bigint NOT NULL DEFAULT 0,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_mfa_totp_cipher_len CHECK (octet_length(secret_ciphertext) BETWEEN 32 AND 512),
    CONSTRAINT user_mfa_totp_last_step_nonneg CHECK (last_step >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON oidc_auth_transactions TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_mfa_totp TO flowforge_app;
