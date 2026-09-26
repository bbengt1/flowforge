package postgres

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMigrateAsRestrictedRole(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	// Restore before the pool closes. t.Cleanup runs after this function's
	// defers, so it cannot use admin.
	defer func() {
		_, _ = admin.Exec(context.Background(), `ALTER ROLE flowforge_app NOBYPASSRLS`)
	}()

	var super bool
	if err := admin.QueryRow(ctx, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&super); err != nil {
		t.Fatal(err)
	}
	if !super {
		t.Skip("restricted-role migrate check needs a superuser admin connection")
	}

	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	password := hex.EncodeToString(buf)
	if _, err := admin.Exec(ctx, `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ff_migrate_check') THEN
				CREATE ROLE ff_migrate_check LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
			ELSE
				ALTER ROLE ff_migrate_check LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
			END IF;
		END
		$$;
	`); err != nil {
		t.Fatal(err)
	}
	var setPassword string
	if err := admin.QueryRow(ctx, `SELECT format('ALTER ROLE ff_migrate_check PASSWORD %L', $1::text)`, password).Scan(&setPassword); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, setPassword); err != nil {
		t.Fatal(err)
	}
	var dbName string
	if err := admin.QueryRow(ctx, `SELECT current_database()`).Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	grant := fmt.Sprintf(`
		GRANT CONNECT ON DATABASE %s TO ff_migrate_check;
		GRANT USAGE ON SCHEMA public TO ff_migrate_check WITH GRANT OPTION;
		GRANT USAGE ON SCHEMA app TO ff_migrate_check WITH GRANT OPTION;
		GRANT ALL ON ALL TABLES IN SCHEMA public TO ff_migrate_check WITH GRANT OPTION;
		GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ff_migrate_check WITH GRANT OPTION;
		GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ff_migrate_check WITH GRANT OPTION;
		GRANT ALL ON ALL FUNCTIONS IN SCHEMA app TO ff_migrate_check WITH GRANT OPTION;
		GRANT flowforge_app TO ff_migrate_check WITH ADMIN OPTION;
	`, quoteIdent(dbName))
	if _, err := admin.Exec(ctx, grant); err != nil {
		t.Fatal(err)
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.User = "ff_migrate_check"
	cfg.ConnConfig.Password = password
	restricted, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restricted.Close()
	if err := restricted.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, restricted); err != nil {
		t.Fatalf("migrate as restricted role: %v", err)
	}

	if _, err := admin.Exec(ctx, `ALTER ROLE flowforge_app BYPASSRLS`); err != nil {
		t.Fatal(err)
	}
	err = Migrate(ctx, restricted)
	if err == nil || !strings.Contains(err.Error(), "BYPASSRLS") {
		t.Fatalf("bypass migrate err = %v", err)
	}
}

func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}
