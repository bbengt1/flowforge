-- E11.2: durable one-time assertion JTIs, overlap verification keys,
-- and embed session (tenant_id, workbench_key) binding.
-- Identity substrate (like browser_sessions): no workspace RLS.
-- Host-supplied tenant is never authorization by itself.

CREATE TABLE embed_assertion_jtis (
    jti          uuid PRIMARY KEY,
    expires_at   timestamptz NOT NULL,
    consumed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX embed_assertion_jtis_expires_idx
    ON embed_assertion_jtis (expires_at);

CREATE TABLE embed_overlap_keys (
    kid          text PRIMARY KEY,
    kty          text NOT NULL DEFAULT 'OKP',
    crv          text NOT NULL DEFAULT 'Ed25519',
    x            text NOT NULL,
    use          text NOT NULL DEFAULT 'sig',
    alg          text NOT NULL DEFAULT 'EdDSA',
    expires_at   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT embed_overlap_keys_kty CHECK (kty = 'OKP'),
    CONSTRAINT embed_overlap_keys_crv CHECK (crv = 'Ed25519'),
    CONSTRAINT embed_overlap_keys_use CHECK (use = 'sig'),
    CONSTRAINT embed_overlap_keys_alg CHECK (alg = 'EdDSA'),
    CONSTRAINT embed_overlap_keys_kid_len CHECK (char_length(kid) BETWEEN 1 AND 128),
    CONSTRAINT embed_overlap_keys_x_len CHECK (char_length(x) BETWEEN 40 AND 64)
);

CREATE INDEX embed_overlap_keys_expires_idx
    ON embed_overlap_keys (expires_at);

ALTER TABLE browser_sessions
    ADD COLUMN embed_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
    ADD COLUMN embed_workbench_key text,
    ADD COLUMN embed_workspace_id uuid REFERENCES workspaces (id) ON DELETE SET NULL,
    ADD COLUMN embed_capabilities text[] NOT NULL DEFAULT '{}',
    ADD CONSTRAINT browser_sessions_embed_tenancy_check CHECK (
        (embed_tenant_id IS NULL AND embed_workbench_key IS NULL AND embed_workspace_id IS NULL)
        OR (
            embed_tenant_id IS NOT NULL
            AND embed_workbench_key IS NOT NULL
            AND embed_workspace_id IS NOT NULL
            AND char_length(embed_workbench_key) BETWEEN 1 AND 64
        )
    );

CREATE INDEX browser_sessions_embed_workspace_idx
    ON browser_sessions (embed_workspace_id)
    WHERE embed_workspace_id IS NOT NULL;
