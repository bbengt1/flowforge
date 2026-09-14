package bootstrap

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
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

func TestPostgresSeedSkipAndStatus(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)

	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	store := NewPostgres(app)
	if _, err := app.Exec(ctx, `
		UPDATE instance_bootstrap
		SET complete = false, skipped = false,
		    persistence_ready = false, first_admin_ready = false,
		    public_url_ready = false, tls_ready = false,
		    public_base_url = '', tls_mode = 'none',
		    completed_at = NULL, updated_at = now()
		WHERE id = 'default'
	`); err != nil {
		t.Fatal(err)
	}

	st, err := store.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Complete {
		t.Fatal("reset row must be incomplete")
	}

	if err := store.MarkSeedSkip(ctx, SeedSkip{PublicBaseURL: "http://localhost:3000"}); err != nil {
		t.Fatal(err)
	}
	st, err = store.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Complete || !st.Skipped || st.PublicBaseURL != "http://localhost:3000" {
		t.Fatalf("postgres seed skip %+v", st)
	}
	assertStatusHasNoSecrets(t, st.Status())

	if err := store.MarkSeedSkip(ctx, SeedSkip{PublicBaseURL: "http://other.example"}); err != nil {
		t.Fatal(err)
	}
	st, err = store.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.PublicBaseURL != "http://localhost:3000" {
		t.Fatalf("second skip must not replace stored URL: %q", st.PublicBaseURL)
	}
}

func TestPostgresSetStepPersistenceDoesNotComplete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)

	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	store := NewPostgres(app)
	if _, err := app.Exec(ctx, `
		UPDATE instance_bootstrap
		SET complete = false, skipped = false,
		    persistence_ready = false, first_admin_ready = false,
		    public_url_ready = false, tls_ready = false,
		    public_base_url = '', tls_mode = 'none',
		    completed_at = NULL, updated_at = now()
		WHERE id = 'default'
	`); err != nil {
		t.Fatal(err)
	}

	if err := store.SetStep(ctx, StepPersistence, true); err != nil {
		t.Fatal(err)
	}
	st, err := store.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !st.PersistenceReady {
		t.Fatal("SetStep persistence must set ready")
	}
	if st.Complete || st.FirstAdminReady {
		t.Fatalf("SetStep must not complete or advance later steps: %+v", st)
	}
	assertStatusHasNoSecrets(t, st.Status())
}

func TestPostgresSetPublicURLDoesNotComplete(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)

	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	store := NewPostgres(app)
	if _, err := app.Exec(ctx, `
		UPDATE instance_bootstrap
		SET complete = false, skipped = false,
		    persistence_ready = true, first_admin_ready = true,
		    public_url_ready = false, tls_ready = false,
		    public_base_url = '', tls_mode = 'none',
		    completed_at = NULL, updated_at = now()
		WHERE id = 'default'
	`); err != nil {
		t.Fatal(err)
	}

	if err := store.SetPublicURL(ctx, "https://flows.example.com/"); err != nil {
		t.Fatal(err)
	}
	st, err := store.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.PublicBaseURL != "https://flows.example.com" {
		t.Fatalf("SetPublicURL must persist normalized column: %q", st.PublicBaseURL)
	}
	if !st.PublicURLReady {
		t.Fatal("SetPublicURL must set public_url_ready")
	}
	if st.Complete || st.TLSReady {
		t.Fatalf("SetPublicURL must not complete or advance TLS: %+v", st)
	}
	assertStatusHasNoSecrets(t, st.Status())
	if _, ok := statusJSON(t, st.Status())["publicBaseUrl"]; ok {
		t.Fatal("status must not echo publicBaseUrl")
	}
}
