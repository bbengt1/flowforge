-- G.2.2 / #447: SCIM directory rows and durable account lockout.
-- Identity substrate (like local_logins): no workspace RLS. The SCIM
-- bearer token is never stored. Groups are workspaces, not a table.

CREATE TABLE scim_users (
    user_id           uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    user_name         text NOT NULL,
    external_id       text NOT NULL DEFAULT '',
    deprovisioned_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT scim_users_user_name_len CHECK (char_length(user_name) BETWEEN 1 AND 256),
    CONSTRAINT scim_users_external_id_len CHECK (char_length(external_id) <= 256)
);

CREATE UNIQUE INDEX scim_users_user_name_active_idx
    ON scim_users (lower(user_name))
    WHERE deprovisioned_at IS NULL;

CREATE UNIQUE INDEX scim_users_external_id_active_idx
    ON scim_users (external_id)
    WHERE deprovisioned_at IS NULL AND external_id <> '';

CREATE TABLE auth_lockouts (
    user_id       uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    failed_count  integer NOT NULL DEFAULT 0,
    locked_at     timestamptz,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT auth_lockouts_failed_nonneg CHECK (failed_count >= 0)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_users TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_lockouts TO flowforge_app;
