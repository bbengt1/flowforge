-- B.1: instance-level first-run bootstrap gate. Singleton, server-only.
-- Not workspace-owned: no FORCE RLS (identity-substrate class, like
-- browser_sessions). Never stores secrets, KEK, passwords, or private keys.
-- GET /api/v1/bootstrap returns status flags only — never public_base_url.

CREATE TABLE instance_bootstrap (
    id                  text PRIMARY KEY DEFAULT 'default'
                        CHECK (id = 'default'),
    complete            boolean NOT NULL DEFAULT false,
    skipped             boolean NOT NULL DEFAULT false,
    persistence_ready   boolean NOT NULL DEFAULT false,
    first_admin_ready   boolean NOT NULL DEFAULT false,
    public_url_ready    boolean NOT NULL DEFAULT false,
    tls_ready           boolean NOT NULL DEFAULT false,
    public_base_url     text NOT NULL DEFAULT '',
    tls_mode            text NOT NULL DEFAULT 'none',
    completed_at        timestamptz,
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT instance_bootstrap_url_len CHECK (char_length(public_base_url) <= 2048),
    CONSTRAINT instance_bootstrap_tls_mode CHECK (tls_mode IN (
        'none', 'self_signed', 'uploaded', 'local_http'
    ))
);

INSERT INTO instance_bootstrap (id) VALUES ('default');

-- Existing installs that already have a tenant/workbench are already
-- bootstrapped (membership was created before this gate existed). Fresh
-- empty databases stay incomplete so the wizard can run.
UPDATE instance_bootstrap
SET complete = true,
    skipped = true,
    persistence_ready = true,
    first_admin_ready = true,
    completed_at = now(),
    updated_at = now()
WHERE id = 'default'
  AND EXISTS (SELECT 1 FROM users)
  AND EXISTS (SELECT 1 FROM workspaces);

GRANT SELECT, INSERT, UPDATE ON instance_bootstrap TO flowforge_app;
