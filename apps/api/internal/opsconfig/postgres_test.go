package opsconfig

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
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

func TestPostgresImmutableVersionsAndCrossWorkspace(t *testing.T) {
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
	tenant, err := ids.CreateTenant(ctx, formatSlug("oc", suffix), "Ops")
	if err != nil {
		t.Fatal(err)
	}
	user, err := ids.UpsertUser(ctx, "https://idp.example", formatSlug("ou", suffix), "Ops User")
	if err != nil {
		t.Fatal(err)
	}
	wsA, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("a", suffix), "A", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	wsB, err := ids.CreateWorkspace(ctx, tenant.ID, formatSlug("b", suffix), "B", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scopeA, err := isolation.Authorize(wsA.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	scopeB, err := isolation.Authorize(wsB.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}

	keys := vault.TestKeys()
	vstore := vault.NewPostgres(app, keys, wfstore.NewPostgres(app))
	cred, err := vstore.Create(ctx, scopeA, vault.CreateInput{
		Type: vault.TypeToken, DisplayName: "Tok", Secret: map[string]string{"token": "abcdefghijklmnop"},
	})
	if err != nil {
		t.Fatal(err)
	}

	store := NewPostgres(app)
	rec, _, err := store.Create(ctx, scopeA, CreateInput{
		Kind: KindClusterTarget,
		Name: "prod",
		Spec: map[string]any{
			"credentialId": cred.ID,
			"endpoint":     map[string]any{"apiServer": "https://kube.example"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scopeA, KindClusterTarget, rec.ID, PublishInput{Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(ctx, scopeB, KindClusterTarget, rec.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get = %v", err)
	}
	if _, err := store.Select(ctx, scopeB, KindClusterTarget, rec.ID, SelectInput{}); err != ErrNotFound {
		t.Fatalf("cross-workspace select = %v", err)
	}

	tx, err := postgres.BeginScoped(ctx, admin, wsA.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = tx.Exec(ctx, `UPDATE ops_resource_versions SET publish_note = 'tamper' WHERE id = $1::uuid`, ver.ID)
	_ = tx.Rollback(ctx)
	if err == nil {
		t.Fatal("expected immutable version update to fail")
	}
}

func formatSlug(prefix string, n int64) string {
	return fmt.Sprintf("%s-%d", prefix, n%100000000)
}
