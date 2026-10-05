-- First-run admin setup token.
--
-- instance_bootstrap stays identity substrate (no workspace RLS, no
-- BYPASSRLS). setup_token_hash is the SHA-256 hex of a one-time token.
-- The plaintext is never stored. session_audit_events gains the
-- bootstrap.admin_password_set type written in the same transaction
-- as the password.

ALTER TABLE instance_bootstrap
    ADD COLUMN setup_token_hash text;

ALTER TABLE instance_bootstrap
    ADD CONSTRAINT instance_bootstrap_setup_token_hash_len
    CHECK (setup_token_hash IS NULL OR setup_token_hash ~ '^[0-9a-f]{64}$');

ALTER TABLE session_audit_events DROP CONSTRAINT session_audit_events_type_check;
ALTER TABLE session_audit_events ADD CONSTRAINT session_audit_events_type_check CHECK (event_type IN (
    'session.created',
    'session.refreshed',
    'session.revoked',
    'session.expired',
    'session.csrf_rejected',
    'session.origin_rejected',
    'session.privilege_denied',
    'session.auth_rejected',
    'bootstrap.admin_password_set'
));
