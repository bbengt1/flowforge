package localseed

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
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

func TestApplyPostgresIdempotent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)

	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()

	store := identity.NewPostgres(app)
	keys := vault.TestKeys()
	vlt := vault.NewPostgres(app, keys, nil)
	in := Input{
		Store:          store,
		Vault:          vlt,
		Keys:           keys,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
	}

	first, err := Apply(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Apply(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if second.Created {
		t.Fatal("second postgres seed must be a no-op")
	}
	if first.Tenant.ID != second.Tenant.ID || first.Workspace.ID != second.Workspace.ID {
		t.Fatal("second run must reuse tenant/workspace")
	}
	if second.CredentialCount != 3 {
		t.Fatalf("credentials = %d", second.CredentialCount)
	}

	scope, err := isolation.AuthorizeTenancy(second.Workspace.ID, second.Users[0].ID, second.Tenant.ID, second.Workspace.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}
	items, err := vlt.List(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("listed %d credentials after second seed", len(items))
	}
}
