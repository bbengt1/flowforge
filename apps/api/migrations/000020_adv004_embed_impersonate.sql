-- ADV-004: embed.impersonate is platform-scoped. Workspace admin
-- must not receive it. Granted only by PLATFORM_ADMINS (same
-- allowlist as platform.administer).

INSERT INTO permissions (key) VALUES
    ('embed.impersonate')
ON CONFLICT (key) DO NOTHING;

UPDATE roles
SET description = 'Platform-scoped operations (tenant/workspace bootstrap, global embed overlap key rotation, and embed.impersonate). Not assignable via workspace membership; granted only by PLATFORM_ADMINS.'
WHERE key = 'platform-admin';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('platform-admin', 'embed.impersonate')
)
ON CONFLICT DO NOTHING;
