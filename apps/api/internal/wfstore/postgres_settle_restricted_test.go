package wfstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSettleStuckRunsAsRestrictedMigrator(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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

	var super bool
	if err := admin.QueryRow(ctx, `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&super); err != nil {
		t.Fatal(err)
	}
	if !super {
		t.Skip("restricted-role migrate check needs a superuser admin connection")
	}

	defer func() {
		ctx := context.Background()
		_, _ = admin.Exec(ctx, `REVOKE flowforge_app FROM ff_settle_migrator`)
		_, _ = admin.Exec(ctx, `REASSIGN OWNED BY ff_settle_migrator TO CURRENT_USER`)
		_, _ = admin.Exec(ctx, `DROP OWNED BY ff_settle_migrator`)
		_, _ = admin.Exec(ctx, `DROP ROLE IF EXISTS ff_settle_migrator`)
		_ = postgres.Migrate(ctx, admin)
	}()

	store := NewPostgres(app)
	wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scopeA, err := isolation.Authorize(wsA, userID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB, userID)
	if err != nil {
		t.Fatal(err)
	}
	stuckA := seedStuckRun(t, ctx, admin, store, scopeA, "stuck-a")
	stuckB := seedStuckRun(t, ctx, admin, store, scopeB, "stuck-b")
	control := seedOpenRun(t, ctx, store, scopeA, "still-open")

	if _, err := admin.Exec(ctx, `DELETE FROM schema_migrations WHERE version = 36`); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `DROP FUNCTION IF EXISTS app.backfill_settle_stuck_runs()`); err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, 18)
	if _, err := rand.Read(buf); err != nil {
		t.Fatal(err)
	}
	password := hex.EncodeToString(buf)
	if _, err := admin.Exec(ctx, `
		DO $$
		BEGIN
			IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ff_settle_migrator') THEN
				CREATE ROLE ff_settle_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
			ELSE
				ALTER ROLE ff_settle_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
			END IF;
		END
		$$;
	`); err != nil {
		t.Fatal(err)
	}
	var setPassword string
	if err := admin.QueryRow(ctx, `SELECT format('ALTER ROLE ff_settle_migrator PASSWORD %L', $1::text)`, password).Scan(&setPassword); err != nil {
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
		GRANT CONNECT ON DATABASE %s TO ff_settle_migrator;
		GRANT USAGE ON SCHEMA public TO ff_settle_migrator WITH GRANT OPTION;
		GRANT USAGE, CREATE ON SCHEMA app TO ff_settle_migrator WITH GRANT OPTION;
		GRANT ALL ON ALL TABLES IN SCHEMA public TO ff_settle_migrator WITH GRANT OPTION;
		GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ff_settle_migrator WITH GRANT OPTION;
		GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ff_settle_migrator WITH GRANT OPTION;
		GRANT ALL ON ALL FUNCTIONS IN SCHEMA app TO ff_settle_migrator WITH GRANT OPTION;
		GRANT flowforge_app TO ff_settle_migrator WITH ADMIN OPTION;
	`, `"`+strings.ReplaceAll(dbName, `"`, `""`)+`"`)
	if _, err := admin.Exec(ctx, grant); err != nil {
		t.Fatal(err)
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.User = "ff_settle_migrator"
	cfg.ConnConfig.Password = password
	restricted, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer restricted.Close()
	if err := postgres.Migrate(ctx, restricted); err != nil {
		t.Fatalf("migrate 000036 as restricted role: %v", err)
	}

	assertExecutionStatus(t, ctx, store, scopeA, stuckA, ExecutionSucceeded)
	assertExecutionStatus(t, ctx, store, scopeB, stuckB, ExecutionSucceeded)
	assertExecutionStatus(t, ctx, store, scopeA, control, ExecutionQueued)

	var forced int
	if err := admin.QueryRow(ctx, `
		SELECT count(*)
		  FROM pg_class c
		  JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public'
		   AND c.relname IN ('workflows', 'executions', 'approvals')
		   AND c.relrowsecurity
		   AND c.relforcerowsecurity
	`).Scan(&forced); err != nil {
		t.Fatal(err)
	}
	if forced != 3 {
		t.Fatalf("FORCE RLS tables = %d", forced)
	}
	var canExecute bool
	if err := admin.QueryRow(ctx, `
		SELECT has_function_privilege('flowforge_app', 'app.backfill_settle_stuck_runs()', 'execute')
	`).Scan(&canExecute); err != nil {
		t.Fatal(err)
	}
	if canExecute {
		t.Fatal("flowforge_app can execute the settle function")
	}
}

func seedStuckRun(t *testing.T, ctx context.Context, admin *pgxpool.Pool, store *Postgres, scope isolation.Scope, slug string) string {
	t.Helper()
	id := seedOpenRun(t, ctx, store, scope, slug)
	if _, err := admin.Exec(ctx, `
		UPDATE execution_jobs SET status = 'succeeded', updated_at = now() WHERE execution_id = $1::uuid
	`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		UPDATE execution_steps SET status = 'succeeded', finished_at = now(), updated_at = now() WHERE execution_id = $1::uuid
	`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec(ctx, `
		UPDATE executions SET status = 'running', updated_at = now() WHERE id = $1::uuid
	`, id); err != nil {
		t.Fatal(err)
	}
	return id
}

func seedOpenRun(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, slug string) string {
	t.Helper()
	normalized := mustNormalize(t, strings.Replace(fixtureYAML, "name: restart-api-rollout", "name: "+slug, 1))
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		Slug:           slug,
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec.ID
}

func assertExecutionStatus(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, id, status string) {
	t.Helper()
	got, err := store.GetExecutionByID(ctx, scope, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != status {
		t.Fatalf("execution %s = %s, want %s", id, got.Status, status)
	}
}
