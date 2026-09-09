-- E4.2: versioned operational configuration.
-- Logical resources from docs/reference/database.md (cluster_targets,
-- ssh_targets, command_profiles, runtime_profiles, connections,
-- recipient_lists, message_templates, response_schemas, policies) share
-- one draft/publish lifecycle. Published revisions are immutable.
-- Pins bind a workflow version or execution to exact resource versions.

CREATE TABLE ops_resources (
    workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    id                   uuid NOT NULL DEFAULT gen_random_uuid(),
    kind                 text NOT NULL,
    slug                 text NOT NULL,
    name                 text NOT NULL,
    status               text NOT NULL DEFAULT 'draft',
    draft_revision       bigint NOT NULL DEFAULT 0,
    credential_id        uuid,
    policy_resource_id   uuid,
    created_by           uuid REFERENCES users (id),
    updated_by           uuid REFERENCES users (id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT ops_resources_kind_check CHECK (kind IN (
        'cluster_target', 'ssh_target', 'command_profile', 'runtime_profile',
        'connection', 'recipient_list', 'message_template', 'response_schema', 'policy'
    )),
    CONSTRAINT ops_resources_status_check CHECK (status IN ('draft', 'published', 'disabled')),
    CONSTRAINT ops_resources_slug_unique UNIQUE (workspace_id, kind, slug),
    CONSTRAINT ops_resources_slug_format CHECK (slug ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT ops_resources_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT ops_resources_draft_revision_check CHECK (draft_revision >= 0),
    CONSTRAINT ops_resources_credential_fk
        FOREIGN KEY (workspace_id, credential_id)
        REFERENCES credentials (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT ops_resources_policy_fk
        FOREIGN KEY (workspace_id, policy_resource_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX ops_resources_workspace_kind_idx
    ON ops_resources (workspace_id, kind, updated_at DESC);
CREATE INDEX ops_resources_id_idx ON ops_resources (id);
CREATE INDEX ops_resources_credential_idx
    ON ops_resources (workspace_id, credential_id)
    WHERE credential_id IS NOT NULL;

CREATE TABLE ops_resource_drafts (
    workspace_id    uuid NOT NULL,
    resource_id     uuid NOT NULL,
    payload         jsonb NOT NULL,
    digest          text NOT NULL,
    revision        bigint NOT NULL,
    updated_by      uuid REFERENCES users (id),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, resource_id),
    CONSTRAINT ops_resource_drafts_fk
        FOREIGN KEY (workspace_id, resource_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT ops_resource_drafts_revision_positive CHECK (revision >= 1),
    CONSTRAINT ops_resource_drafts_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ops_resource_drafts_payload_obj CHECK (jsonb_typeof(payload) = 'object')
);

CREATE TABLE ops_resource_versions (
    workspace_id    uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    resource_id     uuid NOT NULL,
    version_number  integer NOT NULL,
    payload         jsonb NOT NULL,
    digest          text NOT NULL,
    publish_note    text NOT NULL DEFAULT '',
    published_by    uuid REFERENCES users (id),
    published_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT ops_resource_versions_fk
        FOREIGN KEY (workspace_id, resource_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT ops_resource_versions_number_unique UNIQUE (workspace_id, resource_id, version_number),
    CONSTRAINT ops_resource_versions_digest_unique UNIQUE (workspace_id, resource_id, digest),
    CONSTRAINT ops_resource_versions_number_positive CHECK (version_number >= 1),
    CONSTRAINT ops_resource_versions_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ops_resource_versions_note_len CHECK (char_length(publish_note) <= 2000),
    CONSTRAINT ops_resource_versions_payload_obj CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX ops_resource_versions_resource_idx
    ON ops_resource_versions (workspace_id, resource_id, version_number DESC);
CREATE INDEX ops_resource_versions_id_idx ON ops_resource_versions (id);

CREATE TABLE ops_pins (
    workspace_id    uuid NOT NULL,
    id              uuid NOT NULL DEFAULT gen_random_uuid(),
    owner_kind      text NOT NULL,
    owner_id        uuid NOT NULL,
    resource_kind   text NOT NULL,
    resource_id     uuid NOT NULL,
    version_id      uuid NOT NULL,
    version_number  integer NOT NULL,
    digest          text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, id),
    CONSTRAINT ops_pins_resource_fk
        FOREIGN KEY (workspace_id, resource_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT ops_pins_version_fk
        FOREIGN KEY (workspace_id, version_id)
        REFERENCES ops_resource_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT ops_pins_owner_kind_check CHECK (owner_kind IN ('workflow_version', 'execution')),
    CONSTRAINT ops_pins_resource_kind_check CHECK (resource_kind IN (
        'cluster_target', 'ssh_target', 'command_profile', 'runtime_profile',
        'connection', 'recipient_list', 'message_template', 'response_schema', 'policy'
    )),
    CONSTRAINT ops_pins_unique UNIQUE (workspace_id, owner_kind, owner_id, resource_kind, resource_id),
    CONSTRAINT ops_pins_digest_format CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT ops_pins_version_positive CHECK (version_number >= 1)
);

CREATE INDEX ops_pins_owner_idx ON ops_pins (workspace_id, owner_kind, owner_id);
CREATE INDEX ops_pins_id_idx ON ops_pins (id);

CREATE TABLE target_policy_bindings (
    workspace_id        uuid NOT NULL,
    target_kind         text NOT NULL,
    target_id           uuid NOT NULL,
    policy_version_id   uuid NOT NULL,
    bound_at            timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, target_kind, target_id),
    CONSTRAINT target_policy_bindings_target_fk
        FOREIGN KEY (workspace_id, target_id)
        REFERENCES ops_resources (workspace_id, id)
        ON DELETE CASCADE,
    CONSTRAINT target_policy_bindings_policy_fk
        FOREIGN KEY (workspace_id, policy_version_id)
        REFERENCES ops_resource_versions (workspace_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT target_policy_bindings_target_kind_check CHECK (target_kind IN (
        'cluster_target', 'ssh_target', 'command_profile', 'connection'
    ))
);

SELECT app.enable_workspace_isolation('ops_resources');
SELECT app.enable_workspace_isolation('ops_resource_drafts');
SELECT app.enable_workspace_isolation('ops_resource_versions');
SELECT app.enable_workspace_isolation('ops_pins');
SELECT app.enable_workspace_isolation('target_policy_bindings');

CREATE OR REPLACE FUNCTION app.reject_immutable_ops_version()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'operational configuration versions are immutable'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

CREATE TRIGGER ops_resource_versions_immutable
    BEFORE UPDATE OR DELETE ON ops_resource_versions
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_immutable_ops_version();

CREATE OR REPLACE FUNCTION app.reject_immutable_ops_pin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'operational configuration pins are immutable'
        USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

CREATE TRIGGER ops_pins_immutable
    BEFORE UPDATE OR DELETE ON ops_pins
    FOR EACH ROW
    EXECUTE FUNCTION app.reject_immutable_ops_pin();

GRANT SELECT, INSERT, UPDATE, DELETE ON ops_resources TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops_resource_drafts TO flowforge_app;
GRANT SELECT, INSERT ON ops_resource_versions TO flowforge_app;
GRANT SELECT, INSERT ON ops_pins TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON target_policy_bindings TO flowforge_app;

INSERT INTO permissions (key) VALUES
    ('opsconfig.view'),
    ('opsconfig.edit'),
    ('opsconfig.publish'),
    ('opsconfig.use'),
    ('clusterTarget.use'),
    ('sshTarget.use'),
    ('commandProfile.use'),
    ('runtimeProfile.use'),
    ('connection.use'),
    ('recipientList.use'),
    ('messageTemplate.use'),
    ('responseSchema.use'),
    ('policy.use')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('viewer', 'opsconfig.view'),

    ('editor', 'opsconfig.view'),
    ('editor', 'opsconfig.edit'),

    ('publisher', 'opsconfig.view'),
    ('publisher', 'opsconfig.edit'),
    ('publisher', 'opsconfig.publish'),

    ('operator', 'opsconfig.view'),
    ('operator', 'opsconfig.use'),
    ('operator', 'clusterTarget.use'),
    ('operator', 'sshTarget.use'),
    ('operator', 'commandProfile.use'),
    ('operator', 'runtimeProfile.use'),
    ('operator', 'connection.use'),
    ('operator', 'recipientList.use'),
    ('operator', 'messageTemplate.use'),
    ('operator', 'responseSchema.use'),
    ('operator', 'policy.use'),

    ('admin', 'opsconfig.view'),
    ('admin', 'opsconfig.edit'),
    ('admin', 'opsconfig.publish'),
    ('admin', 'opsconfig.use'),
    ('admin', 'clusterTarget.use'),
    ('admin', 'sshTarget.use'),
    ('admin', 'commandProfile.use'),
    ('admin', 'runtimeProfile.use'),
    ('admin', 'connection.use'),
    ('admin', 'recipientList.use'),
    ('admin', 'messageTemplate.use'),
    ('admin', 'responseSchema.use'),
    ('admin', 'policy.use')
)
ON CONFLICT DO NOTHING;
