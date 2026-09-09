package vault

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
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

func TestPostgresStoresCiphertextNotPlaintext(t *testing.T) {
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

	ids := identity.NewPostgres(admin)
	suffix := time.Now().UnixNano()
	tenant, err := ids.CreateTenant(ctx, formatSlug("cv", suffix), "Vault")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("vu", suffix), "Vault User")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("ops", suffix), "Ops", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scope, err := isolation.Authorize(ws.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}

	plain := "super-secret-plaintext-xyz-pg"
	store := NewPostgres(app, TestKeys(), wfstore.NewPostgres(app))
	meta, err := store.Create(ctx, scope, CreateInput{
		Type:        TypeToken,
		DisplayName: "DB secret",
		Secret:      map[string]string{"token": plain},
	})
	if err != nil {
		t.Fatal(err)
	}

	inspect, err := postgres.BeginScoped(ctx, admin, ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	var ct, dek []byte
	var fp, display string
	if err := inspect.QueryRow(ctx, `
		SELECT ciphertext, dek_envelope, fingerprint, display_name
		FROM credentials WHERE id = $1::uuid
	`, meta.ID).Scan(&ct, &dek, &fp, &display); err != nil {
		_ = inspect.Rollback(ctx)
		t.Fatal(err)
	}
	_ = inspect.Rollback(ctx)
	if bytes.Contains(ct, []byte(plain)) || bytes.Contains(dek, []byte(plain)) {
		t.Fatal("plaintext persisted")
	}
	if display != "DB secret" || fp != meta.Fingerprint {
		t.Fatalf("row = %s %s", display, fp)
	}

	got, err := store.Unlock(ctx, scope, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(got, []byte(plain)) {
		t.Fatalf("unlock missing plaintext: %s", got)
	}

	other, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("oth", suffix), "Other", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	otherScope, err := isolation.Authorize(other.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, otherScope, meta.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get = %v", err)
	}

	var visible int
	tx, err := postgres.BeginScoped(ctx, app, other.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM credentials WHERE id = $1::uuid`, meta.ID).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	_ = tx.Rollback(ctx)
	if visible != 0 {
		t.Fatalf("RLS leaked %d rows", visible)
	}
}

func formatSlug(prefix string, n int64) string {
	return fmt.Sprintf("%s%d", prefix, n%100000000)
}
