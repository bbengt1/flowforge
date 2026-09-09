package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// ensureAppRoleSQL recreates the request role and table grants. pg_dump of a
// database does not include CREATE ROLE, and restore rehearsal uses --no-acl,
// so a restored cluster can have schema_migrations applied without
// flowforge_app. Boot must repair that before SET ROLE on checkout.
const ensureAppRoleSQL = `
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge_app') THEN
        CREATE ROLE flowforge_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    ELSE
        ALTER ROLE flowforge_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    END IF;
    GRANT flowforge_app TO CURRENT_USER;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge')
       AND CURRENT_USER <> 'flowforge' THEN
        GRANT flowforge_app TO flowforge;
    END IF;
END
$$;
GRANT USAGE ON SCHEMA public TO flowforge_app;
GRANT USAGE ON SCHEMA app TO flowforge_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO flowforge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flowforge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flowforge_app;
DO $$
DECLARE
    r record;
BEGIN
    IF to_regclass('public.workflow_versions') IS NOT NULL THEN
        REVOKE UPDATE, DELETE ON workflow_versions FROM flowforge_app;
    END IF;
    IF to_regclass('public.audit_events') IS NOT NULL THEN
        REVOKE UPDATE, DELETE ON audit_events FROM flowforge_app;
    END IF;
    FOR r IN
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relname LIKE 'audit_events_%'
    LOOP
        EXECUTE format('REVOKE UPDATE, DELETE ON TABLE %I FROM flowforge_app', r.relname);
    END LOOP;
    IF to_regclass('public.credential_events') IS NOT NULL THEN
        REVOKE UPDATE ON credential_events FROM flowforge_app;
    END IF;
    IF to_regclass('public.ops_resource_versions') IS NOT NULL THEN
        REVOKE UPDATE, DELETE ON ops_resource_versions FROM flowforge_app;
    END IF;
    IF to_regclass('public.ops_pins') IS NOT NULL THEN
        REVOKE UPDATE, DELETE ON ops_pins FROM flowforge_app;
    END IF;
END
$$;
`

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func ensureAppRole(ctx context.Context, db execer) error {
	if _, err := db.Exec(ctx, ensureAppRoleSQL); err != nil {
		return fmt.Errorf("ensure %s role: %w", AppRole, err)
	}
	return nil
}
