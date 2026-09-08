package postgres

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestOpenRecreatesAppRoleAfterClusterRestore(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	admin, err := OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `DROP OWNED BY `+AppRole); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `DROP ROLE IF EXISTS `+AppRole); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	admin.Close()

	app, err := Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	var role string
	if err := app.QueryRow(ctx, `SELECT current_user`).Scan(&role); err != nil {
		t.Fatal(err)
	}
	if role != AppRole {
		t.Fatalf("current_user = %s, want %s after role recreate", role, AppRole)
	}

	var n int
	if err := app.QueryRow(ctx, `SELECT count(*) FROM workspace_records`).Scan(&n); err != nil {
		t.Fatalf("app role cannot read isolated tables: %v", err)
	}
	if n != 0 {
		t.Fatalf("unset scope leaked %d rows", n)
	}
}
