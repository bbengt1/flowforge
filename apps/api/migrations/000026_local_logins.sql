-- V.0a local login credentials. Identity substrate (like users /
-- browser_sessions): no workspace RLS. Password hashes never appear in
-- User JSON, GET /session, bootstrap status, logs, or localStorage.

CREATE TABLE local_logins (
    user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    identifier     text NOT NULL,
    password_hash  text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT local_logins_identifier_len CHECK (char_length(identifier) BETWEEN 1 AND 256),
    CONSTRAINT local_logins_hash_len CHECK (char_length(password_hash) BETWEEN 1 AND 255)
);

-- Case-insensitive unique email-or-username for local sign-in.
CREATE UNIQUE INDEX local_logins_identifier_norm_idx
    ON local_logins (lower(identifier));

GRANT SELECT, INSERT, UPDATE, DELETE ON local_logins TO flowforge_app;
