-- Soft-delete tombstone for workflows. The row stays so the slug stays
-- reserved and version history stays stored. A non-null deleted_at hides
-- the workflow from reads. FORCE RLS is unchanged.

ALTER TABLE workflows
    ADD COLUMN deleted_at timestamptz;

COMMENT ON COLUMN workflows.deleted_at IS
    'Soft-delete tombstone. Non-null hides the workflow. The slug stays reserved.';

INSERT INTO permissions (key) VALUES
    ('workflow.delete')
ON CONFLICT (key) DO NOTHING;

UPDATE roles
SET description = 'Create, edit, and delete workflows. Cannot publish, execute, or administer the workspace.'
WHERE key = 'editor';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON (r.key, p.key) IN (
    ('editor', 'workflow.delete'),
    ('admin', 'workflow.delete')
)
ON CONFLICT DO NOTHING;
