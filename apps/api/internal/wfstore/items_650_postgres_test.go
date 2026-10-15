package wfstore

import (
	"context"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Postgres-only #650 E3.1 checks: FORCE RLS as the app role (T1) and the
// workspace hard delete / tenant purge cascades (T12).
func runItemsPostgresOnly(t *testing.T, ctx context.Context, admin *pgxpool.Pool, app *pgxpool.Pool, newH func(t *testing.T) itemsHarness) {
	t.Run("T1 items_rls_cross_workspace direct SQL as the app role", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(2, 1)}); err != nil {
			t.Fatal(err)
		}
		tx, err := postgres.BeginScoped(ctx, app, h.other.WorkspaceID())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM execution_step_items WHERE step_id = $1::uuid`, steps["a"].ID).Scan(&n); err != nil || n != 0 {
			t.Fatalf("other workspace sees %d rows (%v)", n, err)
		}
		var role string
		_ = tx.QueryRow(ctx, `SELECT current_user`).Scan(&role)
		var bypass bool
		if err := tx.QueryRow(ctx, `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`).Scan(&bypass); err != nil || bypass {
			t.Fatalf("role %s bypassrls=%v %v", role, bypass, err)
		}
	})
	t.Run("T1 items_rls_write_direct_sql refused", func(t *testing.T) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(1, 1)}); err != nil {
			t.Fatal(err)
		}
		stmts := []struct {
			name string
			sql  string
		}{
			{"insert foreign workspace id", `INSERT INTO execution_step_items (workspace_id, step_id, port, idx, item_redacted, bytes, lineage) VALUES ('` + h.scope.WorkspaceID() + `'::uuid, $1::uuid, 'x', 0, '{}', 2, '{}')`},
			{"insert own workspace id onto foreign step", `INSERT INTO execution_step_items (workspace_id, step_id, port, idx, item_redacted, bytes, lineage) VALUES ('` + h.other.WorkspaceID() + `'::uuid, $1::uuid, 'x', 0, '{}', 2, '{}')`},
			{"update", `UPDATE execution_step_items SET item_redacted = '{"pwned":true}' WHERE step_id = $1::uuid`},
		}
		for _, st := range stmts {
			t.Run(st.name, func(t *testing.T) {
				tx, err := postgres.BeginScoped(ctx, app, h.other.WorkspaceID())
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				tag, err := tx.Exec(ctx, st.sql, steps["a"].ID)
				if err == nil && tag.RowsAffected() != 0 {
					t.Fatalf("%s affected %d rows", st.name, tag.RowsAffected())
				}
			})
		}
		if n := h.countItemRows(steps["a"].ID); n != 1 {
			t.Fatalf("rows = %d", n)
		}
		page := h.list(exec, steps["a"], "main", -1, 0)
		if page.Items[0].Item["pwned"] != nil {
			t.Fatal("row was updated")
		}
	})
	t.Run("T1 CHECK constraints refuse malformed rows", func(t *testing.T) {
		h := newH(t)
		_, steps := h.start()
		for _, bad := range []string{
			`'', 0, '{}', 2, '{}'`,
			`'p', 1000, '{}', 2, '{}'`,
			`'p', -1, '{}', 2, '{}'`,
			`'p', 0, '{}', 16385, '{}'`,
			`'p', 0, '[]', 2, '{}'`,
			`'p', 0, '{}', 2, '"x"'`,
		} {
			tx, err := postgres.BeginScoped(ctx, app, h.scope.WorkspaceID())
			if err != nil {
				t.Fatal(err)
			}
			_, err = tx.Exec(ctx, `INSERT INTO execution_step_items (workspace_id, step_id, port, idx, item_redacted, bytes, lineage) VALUES ($1::uuid, $2::uuid, `+bad+`)`, h.scope.WorkspaceID(), steps["a"].ID)
			_ = tx.Rollback(ctx)
			if err == nil {
				t.Fatalf("accepted %s", bad)
			}
		}
	})
	cascade := func(t *testing.T, stmts func(ws, tenant string) []string) {
		h := newH(t)
		exec, steps := h.start()
		if _, err := h.put(exec, steps["a"], PortItems{Port: "main", Items: makeItems(3, 1)}); err != nil {
			t.Fatal(err)
		}
		ws := h.scope.WorkspaceID()
		var tenant string
		if err := admin.QueryRow(ctx, `SELECT tenant_id::text FROM workspaces WHERE id = $1::uuid`, ws).Scan(&tenant); err != nil {
			t.Fatal(err)
		}
		tx, err := admin.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		// Published versions and audit rows are immutable; lift those guards
		// inside this rolled-back transaction (same approach as #649 S3).
		if _, err := tx.Exec(ctx, `
			DO $$
			DECLARE r regclass;
			BEGIN
			  FOR r IN SELECT DISTINCT t.tgrelid::regclass FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
			           WHERE NOT t.tgisinternal AND p.prosrc ILIKE '%RAISE EXCEPTION%'
			  LOOP
			    EXECUTE format('ALTER TABLE %s DISABLE TRIGGER USER', r);
			  END LOOP;
			END $$`); err != nil {
			t.Skipf("cannot lift the immutability guards as this role: %v", err)
		}
		for _, stmt := range stmts(ws, tenant) {
			if _, err := tx.Exec(ctx, stmt); err != nil {
				t.Fatalf("%s blocked: %v", stmt, err)
			}
		}
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM execution_step_items WHERE step_id = $1::uuid OR workspace_id = $2::uuid`, steps["a"].ID, ws).Scan(&n); err != nil || n != 0 {
			t.Fatalf("items survived: %d %v", n, err)
		}
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM workspaces WHERE id = $1::uuid`, ws).Scan(&n); err != nil || n != 0 {
			t.Fatalf("workspace survived: %d %v", n, err)
		}
	}
	t.Run("T12 items_workspace_hard_delete_cascade", func(t *testing.T) {
		cascade(t, func(ws, _ string) []string {
			// executions_workflow_fk is ON DELETE RESTRICT (000005), so a
			// workspace hard delete removes runs first; items must neither
			// block it nor survive it.
			return []string{
				`DELETE FROM executions WHERE workspace_id = '` + ws + `'::uuid`,
				`DELETE FROM workspaces WHERE id = '` + ws + `'::uuid`,
			}
		})
	})
	t.Run("T12 items_tenant_purge_cascade", func(t *testing.T) {
		cascade(t, func(_, tenant string) []string {
			return []string{
				`DELETE FROM executions WHERE workspace_id IN (SELECT id FROM workspaces WHERE tenant_id = '` + tenant + `'::uuid)`,
				`DELETE FROM workspaces WHERE tenant_id = '` + tenant + `'::uuid`,
				`DELETE FROM tenants WHERE id = '` + tenant + `'::uuid`,
			}
		})
	})
}
