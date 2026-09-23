-- G.2.8 / #453: shared rate limits.
-- auth_rate_windows is not workspace-scoped. Login, embed mint/exchange,
-- machine token, OIDC, and MFA are evaluated before a workspace exists
-- and must not share the workspace quota bucket. key_hash is sha256 of
-- the limiter key so identifiers and client IPs are not stored.
-- workspace_quotas is per workspace (FORCE RLS). One row per class.

CREATE TABLE auth_rate_windows (
    key_hash      text NOT NULL,
    window_start  timestamptz NOT NULL,
    count         integer NOT NULL,
    PRIMARY KEY (key_hash),
    CONSTRAINT auth_rate_windows_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT auth_rate_windows_count_check CHECK (count >= 0)
);

CREATE TABLE workspace_quotas (
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    bucket        text NOT NULL,
    tokens        double precision NOT NULL,
    updated_at    timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, bucket),
    CONSTRAINT workspace_quotas_bucket_check CHECK (bucket IN ('mutate', 'read', 'download', 'execute')),
    CONSTRAINT workspace_quotas_tokens_check CHECK (tokens >= 0 AND tokens <= 1000000)
);

SELECT app.enable_workspace_isolation('workspace_quotas');

GRANT SELECT, INSERT, UPDATE, DELETE ON auth_rate_windows TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_quotas TO flowforge_app;
