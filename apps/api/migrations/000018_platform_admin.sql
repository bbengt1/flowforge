-- ADV-001: platform.administer is platform-scoped. Workspace admin
-- must not receive it, and platform-admin is not assigned via
-- workspace_role_bindings (API rejects that role key).

INSERT INTO permissions (key) VALUES
    ('platform.administer')
ON CONFLICT (key) DO NOTHING;

INSERT INTO roles (key, description) VALUES
    ('platform-admin', 'Platform-scoped operations (global embed overlap key rotation). Not assignable via workspace membership; granted only by PLATFORM_ADMINS.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('platform-admin', 'platform.administer')
)
ON CONFLICT DO NOTHING;
