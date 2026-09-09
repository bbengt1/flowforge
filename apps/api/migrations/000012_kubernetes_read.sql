-- E7.2: kubernetes.read for get/list (apply already exists).

INSERT INTO permissions (key) VALUES
    ('kubernetes.read')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('operator', 'kubernetes.read'),
    ('admin', 'kubernetes.read')
)
ON CONFLICT DO NOTHING;
