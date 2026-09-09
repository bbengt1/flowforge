-- E9.4: artifact revocation + emergency stop.
-- script_artifacts.revoked_at already exists; allow the app role to set it
-- (and revoked_by / secret-free metadata) without mutating the package.

ALTER TABLE script_artifacts
    ADD COLUMN IF NOT EXISTS revoked_by uuid REFERENCES users (id);

GRANT UPDATE (revoked_at, revoked_by, metadata) ON script_artifacts TO flowforge_app;

INSERT INTO permissions (key) VALUES
    ('script.revoke'),
    ('script.emergencyStop')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('operator', 'script.revoke'),
    ('operator', 'script.emergencyStop'),
    ('admin', 'script.revoke'),
    ('admin', 'script.emergencyStop')
)
ON CONFLICT DO NOTHING;
