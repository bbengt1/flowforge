-- Per-workspace SCIM bearer tokens and per-workspace SCIM user links.
--
-- scim_tokens is authorization substrate, like machine_principals: no
-- workspace RLS, because the SCIM door resolves a bearer to its
-- workspace before any scope exists. It is read by token hash only on
-- that path, and by workspace id only on the admin routes after
-- workspace.administer. The plaintext token is never stored: token_hash
-- is the lowercase hex SHA-256 of the whole presented string, prefix
-- included. Revoking sets revoked_at; rows are never reused.
--
-- At most two tokens per workspace are active (revoked_at IS NULL).
-- Each active token holds slot 1 or 2, and a partial unique index on
-- (workspace_id, slot) enforces the limit under concurrency. The API
-- maps a violation to 409 scim_token_limit.
--
-- scim_workspace_users links a users row to one workspace's SCIM
-- directory: the userName and externalId that workspace's IdP sent.
-- Both are unique per workspace only, so two workspaces may use the same
-- userName for the same or different people. FORCE RLS via the
-- isolation helper. A row exists while that workspace's token can see
-- the user; SCIM DELETE removes it. deactivated_at is set by SCIM
-- active:false, which also removes the user's role bindings and group
-- rows in that workspace but keeps the link; active:true clears it and
-- restores membership. Neither touches users.status.
--
-- Schema migrations are forward-only, so this file has no down script.
-- Audit actions need no schema change because audit_events.action has a
-- length check only.

CREATE TABLE scim_tokens (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    display_name  text NOT NULL,
    token_hash    text NOT NULL,
    slot          smallint NOT NULL,
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_used_at  timestamptz,
    revoked_at    timestamptz,
    CONSTRAINT scim_tokens_hash_unique UNIQUE (token_hash),
    CONSTRAINT scim_tokens_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT scim_tokens_display_name_len
        CHECK (char_length(display_name) BETWEEN 1 AND 128),
    CONSTRAINT scim_tokens_display_name_trimmed
        CHECK (display_name = btrim(display_name)),
    CONSTRAINT scim_tokens_slot_range CHECK (slot IN (1, 2))
);

CREATE UNIQUE INDEX scim_tokens_active_slot_uidx
    ON scim_tokens (workspace_id, slot)
    WHERE revoked_at IS NULL;

CREATE INDEX scim_tokens_workspace_idx
    ON scim_tokens (workspace_id, created_at);

CREATE TABLE scim_workspace_users (
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    user_name     text NOT NULL,
    external_id   text NOT NULL DEFAULT '',
    deactivated_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT scim_workspace_users_user_name_len
        CHECK (char_length(user_name) BETWEEN 1 AND 256),
    CONSTRAINT scim_workspace_users_external_id_len
        CHECK (char_length(external_id) <= 256)
);

CREATE UNIQUE INDEX scim_workspace_users_user_name_uidx
    ON scim_workspace_users (workspace_id, lower(user_name));

CREATE UNIQUE INDEX scim_workspace_users_external_id_uidx
    ON scim_workspace_users (workspace_id, external_id)
    WHERE external_id <> '';

SELECT app.enable_workspace_isolation('scim_workspace_users');

GRANT SELECT, INSERT, UPDATE, DELETE ON scim_tokens TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scim_workspace_users TO flowforge_app;
