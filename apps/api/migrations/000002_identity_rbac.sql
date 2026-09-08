-- E2.1: tenants, workspaces, users, roles, permissions, and bindings.
-- Workspace identity is unique on (tenant_id, workbench_key).
-- RLS helpers are installed for E2.2; this migration does not FORCE RLS.

CREATE SCHEMA IF NOT EXISTS app;

-- Transaction-local workspace scope. E2.2 will set this only after
-- authorization and ENABLE / FORCE ROW LEVEL SECURITY on workspace-owned
-- tables. An unset or empty setting must match no rows.
CREATE OR REPLACE FUNCTION app.current_workspace_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.set_workspace_id(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    IF p_workspace_id IS NULL THEN
        PERFORM set_config('app.workspace_id', '', true);
        RETURN;
    END IF;
    PERFORM set_config('app.workspace_id', p_workspace_id::text, true);
END;
$$;

CREATE TABLE tenants (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        text NOT NULL,
    name        text NOT NULL,
    status      text NOT NULL DEFAULT 'active',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tenants_slug_unique UNIQUE (slug),
    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z][a-z0-9-]{0,62}$'),
    CONSTRAINT tenants_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT tenants_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE workspaces (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES tenants (id),
    workbench_key  text NOT NULL,
    name           text NOT NULL,
    status         text NOT NULL DEFAULT 'active',
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT workspaces_tenant_workbench_unique UNIQUE (tenant_id, workbench_key),
    CONSTRAINT workspaces_workbench_key_format CHECK (workbench_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    CONSTRAINT workspaces_name_len CHECK (char_length(name) BETWEEN 1 AND 200),
    CONSTRAINT workspaces_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX workspaces_tenant_id_idx ON workspaces (tenant_id);

CREATE TABLE users (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    issuer            text NOT NULL,
    external_subject  text NOT NULL,
    display_name      text NOT NULL DEFAULT '',
    status            text NOT NULL DEFAULT 'active',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_issuer_subject_unique UNIQUE (issuer, external_subject),
    CONSTRAINT users_issuer_len CHECK (char_length(issuer) BETWEEN 1 AND 512),
    CONSTRAINT users_subject_len CHECK (char_length(external_subject) BETWEEN 1 AND 256),
    CONSTRAINT users_display_name_len CHECK (char_length(display_name) <= 200),
    CONSTRAINT users_status_check CHECK (status IN ('active', 'disabled'))
);

CREATE TABLE roles (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key          text NOT NULL,
    description  text NOT NULL DEFAULT '',
    CONSTRAINT roles_key_unique UNIQUE (key)
);

CREATE TABLE permissions (
    id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    key  text NOT NULL,
    CONSTRAINT permissions_key_unique UNIQUE (key)
);

CREATE TABLE role_permissions (
    role_id        uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
    permission_id  uuid NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE workspace_role_bindings (
    workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role_id       uuid NOT NULL REFERENCES roles (id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id, role_id)
);

CREATE INDEX workspace_role_bindings_user_id_idx ON workspace_role_bindings (user_id);

INSERT INTO permissions (key) VALUES
    ('workflow.view'),
    ('workflow.edit'),
    ('workflow.publish'),
    ('workflow.execute'),
    ('execution.view'),
    ('execution.cancel'),
    ('credential.view'),
    ('credential.use'),
    ('credential.manage'),
    ('approval.view'),
    ('approval.decide'),
    ('workspace.administer'),
    ('kubernetes.apply'),
    ('ssh.run');

INSERT INTO roles (key, description) VALUES
    ('viewer', 'Read workflows, executions, and approval status. Cannot edit, run, or manage credentials.'),
    ('editor', 'Create and edit workflow drafts. Cannot publish, execute, or administer the workspace.'),
    ('publisher', 'Edit and publish workflow versions. Cannot execute or administer.'),
    ('operator', 'Execute published workflows and use credentials. Cannot edit definitions or administer.'),
    ('approver', 'Decide pending approvals. Cannot edit, execute, or administer.'),
    ('admin', 'Full workspace administration including membership, credentials, and all workflow actions.');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('viewer', 'workflow.view'),
    ('viewer', 'execution.view'),
    ('viewer', 'approval.view'),

    ('editor', 'workflow.view'),
    ('editor', 'workflow.edit'),
    ('editor', 'execution.view'),
    ('editor', 'credential.view'),
    ('editor', 'approval.view'),

    ('publisher', 'workflow.view'),
    ('publisher', 'workflow.edit'),
    ('publisher', 'workflow.publish'),
    ('publisher', 'execution.view'),
    ('publisher', 'credential.view'),
    ('publisher', 'approval.view'),

    ('operator', 'workflow.view'),
    ('operator', 'workflow.execute'),
    ('operator', 'execution.view'),
    ('operator', 'execution.cancel'),
    ('operator', 'credential.view'),
    ('operator', 'credential.use'),
    ('operator', 'approval.view'),
    ('operator', 'kubernetes.apply'),
    ('operator', 'ssh.run'),

    ('approver', 'workflow.view'),
    ('approver', 'execution.view'),
    ('approver', 'approval.view'),
    ('approver', 'approval.decide'),

    ('admin', 'workflow.view'),
    ('admin', 'workflow.edit'),
    ('admin', 'workflow.publish'),
    ('admin', 'workflow.execute'),
    ('admin', 'execution.view'),
    ('admin', 'execution.cancel'),
    ('admin', 'credential.view'),
    ('admin', 'credential.use'),
    ('admin', 'credential.manage'),
    ('admin', 'approval.view'),
    ('admin', 'approval.decide'),
    ('admin', 'workspace.administer'),
    ('admin', 'kubernetes.apply'),
    ('admin', 'ssh.run')
);
