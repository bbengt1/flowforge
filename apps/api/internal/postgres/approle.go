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
DECLARE
    app_login boolean;
    app_super boolean;
    app_bypass boolean;
    app_inherit boolean;
    caller_super boolean;
    caller_bypass boolean;
BEGIN
    SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit
      INTO app_login, app_super, app_bypass, app_inherit
      FROM pg_roles
     WHERE rolname = 'flowforge_app';
    IF NOT FOUND THEN
        CREATE ROLE flowforge_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
    ELSIF app_login OR app_super OR app_bypass OR app_inherit THEN
        SELECT rolsuper, rolbypassrls
          INTO caller_super, caller_bypass
          FROM pg_roles
         WHERE rolname = current_user;
        IF app_super AND NOT caller_super THEN
            RAISE EXCEPTION 'flowforge_app has SUPERUSER and migration role % cannot remove it', current_user
                USING ERRCODE = '42501';
        END IF;
        IF app_bypass AND NOT caller_super AND NOT caller_bypass THEN
            RAISE EXCEPTION 'flowforge_app has BYPASSRLS and migration role % cannot remove it; run migrations as a superuser or a role with BYPASSRLS', current_user
                USING ERRCODE = '42501';
        END IF;
        -- Only attributes that differ. A non-superuser can clear LOGIN or
        -- INHERIT without sending NOSUPERUSER or NOBYPASSRLS.
        IF app_login THEN
            ALTER ROLE flowforge_app NOLOGIN;
        END IF;
        IF app_super THEN
            ALTER ROLE flowforge_app NOSUPERUSER;
        END IF;
        IF app_bypass THEN
            ALTER ROLE flowforge_app NOBYPASSRLS;
        END IF;
        IF app_inherit THEN
            ALTER ROLE flowforge_app NOINHERIT;
        END IF;
    END IF;
    IF NOT pg_has_role(current_user, 'flowforge_app', 'MEMBER') THEN
        GRANT flowforge_app TO CURRENT_USER;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flowforge')
       AND current_user <> 'flowforge'
       AND NOT pg_has_role('flowforge', 'flowforge_app', 'MEMBER') THEN
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
    -- Global execution backfill is migration-only. GRANT EXECUTE ON ALL
    -- FUNCTIONS above would otherwise hand it to the request role.
    IF to_regprocedure('app.backfill_execution_dependencies()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION app.backfill_execution_dependencies() FROM PUBLIC;
        REVOKE ALL ON FUNCTION app.backfill_execution_dependencies() FROM flowforge_app;
    END IF;
    IF to_regprocedure('app.backfill_execution_edge_resolution()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION app.backfill_execution_edge_resolution() FROM PUBLIC;
        REVOKE ALL ON FUNCTION app.backfill_execution_edge_resolution() FROM flowforge_app;
    END IF;
    IF to_regprocedure('app.backfill_close_stale_approvals()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION app.backfill_close_stale_approvals() FROM PUBLIC;
        REVOKE ALL ON FUNCTION app.backfill_close_stale_approvals() FROM flowforge_app;
    END IF;
    IF to_regprocedure('app.backfill_settle_stuck_runs()') IS NOT NULL THEN
        REVOKE ALL ON FUNCTION app.backfill_settle_stuck_runs() FROM PUBLIC;
        REVOKE ALL ON FUNCTION app.backfill_settle_stuck_runs() FROM flowforge_app;
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
