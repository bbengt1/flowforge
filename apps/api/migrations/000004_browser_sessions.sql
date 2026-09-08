-- E2.3: server-side browser sessions and session audit.
-- Identity substrate (like users): no workspace RLS. Cookie secrets are
-- stored only as SHA-256 hashes. Audit rows never contain tokens.

CREATE TABLE browser_sessions (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash           bytea NOT NULL,
    csrf_hash            bytea NOT NULL,
    created_at           timestamptz NOT NULL DEFAULT now(),
    last_seen_at         timestamptz NOT NULL DEFAULT now(),
    idle_expires_at      timestamptz NOT NULL,
    absolute_expires_at  timestamptz NOT NULL,
    revoked_at           timestamptz,
    CONSTRAINT browser_sessions_token_hash_unique UNIQUE (token_hash),
    CONSTRAINT browser_sessions_token_hash_len CHECK (octet_length(token_hash) = 32),
    CONSTRAINT browser_sessions_csrf_hash_len CHECK (octet_length(csrf_hash) = 32)
);

CREATE INDEX browser_sessions_user_id_idx ON browser_sessions (user_id);
CREATE INDEX browser_sessions_idle_expires_at_idx ON browser_sessions (idle_expires_at);

CREATE TABLE session_audit_events (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    session_id  uuid,
    event_type  text NOT NULL,
    outcome     text NOT NULL,
    reason      text NOT NULL,
    request_id  text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT session_audit_events_type_check CHECK (event_type IN (
        'session.created',
        'session.refreshed',
        'session.revoked',
        'session.expired',
        'session.csrf_rejected',
        'session.origin_rejected',
        'session.privilege_denied',
        'session.auth_rejected'
    )),
    CONSTRAINT session_audit_events_outcome_check CHECK (outcome IN ('allowed', 'denied')),
    CONSTRAINT session_audit_events_reason_len CHECK (char_length(reason) BETWEEN 1 AND 200),
    CONSTRAINT session_audit_events_request_id_len CHECK (char_length(request_id) <= 128)
);

CREATE INDEX session_audit_events_user_created_idx
    ON session_audit_events (user_id, created_at DESC);
