package isolation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testDatabaseURL(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	return dsn
}

func TestPostgresRLSUnsetStaleAndCrossWorkspace(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)

	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	wsA, wsB := seedTwoWorkspaces(t, ctx, admin)
	recA := seedRecord(t, ctx, admin, wsA, KindCredential, "cred-a")
	_ = seedRecord(t, ctx, admin, wsB, KindCredential, "cred-b")

	t.Run("unset scope returns no rows", func(t *testing.T) {
		var n int
		if err := app.QueryRow(ctx, `SELECT count(*) FROM workspace_records`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("unset pooled scope returned %d rows", n)
		}
	})

	t.Run("stale session scope is reset on checkout", func(t *testing.T) {
		conn, err := app.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Exec(ctx, `SELECT set_config('app.workspace_id', $1, false)`, wsA); err != nil {
			conn.Release()
			t.Fatal(err)
		}
		var visible int
		if err := conn.QueryRow(ctx, `SELECT count(*) FROM workspace_records`).Scan(&visible); err != nil {
			conn.Release()
			t.Fatal(err)
		}
		if visible == 0 {
			conn.Release()
			t.Fatal("expected rows while session scope is set")
		}
		conn.Release()

		conn2, err := app.Acquire(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer conn2.Release()
		var setting string
		if err := conn2.QueryRow(ctx, `SELECT current_setting('app.workspace_id', true)`).Scan(&setting); err != nil {
			t.Fatal(err)
		}
		if setting != "" {
			t.Fatalf("stale scope survived checkout: %q", setting)
		}
		var n int
		if err := conn2.QueryRow(ctx, `SELECT count(*) FROM workspace_records`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("stale pooled session returned %d rows", n)
		}
	})

	t.Run("cross-workspace read and write fail", func(t *testing.T) {
		store := NewPostgres(app)
		scopeB, err := Authorize(wsB, "")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.Get(ctx, scopeB, recA); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-workspace get = %v", err)
		}
		items, err := store.List(ctx, scopeB, KindCredential)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range items {
			if item.ID == recA || item.WorkspaceID == wsA {
				t.Fatalf("list leaked %+v", item)
			}
		}
		if err := store.UseCredential(ctx, scopeB, recA); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-workspace use = %v", err)
		}
		if _, err := store.Link(ctx, scopeB, recA, KindJob); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cross-workspace link = %v", err)
		}
	})

	t.Run("composite FK rejects other workspace UUID", func(t *testing.T) {
		tx, err := postgres.BeginScoped(ctx, app, wsB)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		_, err = tx.Exec(ctx, `
			INSERT INTO workspace_record_links (workspace_id, parent_id, kind)
			VALUES ($1::uuid, $2::uuid, 'job')
		`, wsB, recA)
		if err == nil {
			t.Fatal("expected composite FK rejection")
		}
		if !errors.Is(mapDBErr(err), ErrNotFound) {
			t.Fatalf("fk error = %v", err)
		}
	})

	t.Run("force rls is enabled", func(t *testing.T) {
		for _, table := range []string{"workspace_records", "workspace_record_links"} {
			var forced bool
			err := admin.QueryRow(ctx, `
				SELECT c.relforcerowsecurity
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relname = $1
			`, table).Scan(&forced)
			if err != nil {
				t.Fatal(err)
			}
			if !forced {
				t.Fatalf("%s missing FORCE ROW LEVEL SECURITY", table)
			}
		}
	})

	t.Run("app pool is not the login superuser", func(t *testing.T) {
		var role string
		if err := app.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil {
			t.Fatal(err)
		}
		if role != postgres.AppRole {
			t.Fatalf("current_user = %s, want %s", role, postgres.AppRole)
		}
	})
}

func TestSetWorkspaceIDDoesNotPersistOutsideTransaction(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	app, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	conn, err := app.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(ctx, `SELECT app.set_workspace_id('11111111-1111-1111-1111-111111111111'::uuid)`); err != nil {
		t.Fatal(err)
	}
	var setting string
	if err := conn.QueryRow(ctx, `SELECT current_setting('app.workspace_id', true)`).Scan(&setting); err != nil {
		t.Fatal(err)
	}
	if setting != "" {
		t.Fatalf("transaction-local scope leaked to the session: %q", setting)
	}
}

func seedTwoWorkspaces(t *testing.T, ctx context.Context, db *pgxpool.Pool) (string, string) {
	t.Helper()
	store := identity.NewPostgres(db)
	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	tenant, err := store.CreateTenant(ctx, "iso-"+suffix[:10], "ISO")
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUser(ctx, "https://idp.example", "iso-"+suffix, "Iso")
	if err != nil {
		t.Fatal(err)
	}
	a, err := store.CreateWorkspace(ctx, tenant.ID, "bench-a-"+suffix[len(suffix)-8:], "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	b, err := store.CreateWorkspace(ctx, tenant.ID, "bench-b-"+suffix[len(suffix)-8:], "B", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	return a.ID, b.ID
}

func seedRecord(t *testing.T, ctx context.Context, db *pgxpool.Pool, workspaceID, kind, name string) string {
	t.Helper()
	var id string
	err := db.QueryRow(ctx, `
		INSERT INTO workspace_records (workspace_id, kind, name)
		VALUES ($1::uuid, $2, $3)
		RETURNING id::text
	`, workspaceID, kind, name).Scan(&id)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
