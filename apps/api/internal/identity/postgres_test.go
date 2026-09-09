package identity

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

func TestPostgresUniqueTenantWorkbench(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	store := NewPostgres(pool)
	suffix := newID()[:8]
	tenant, err := store.CreateTenant(ctx, "t-"+suffix, "Tenant "+suffix)
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUser(ctx, "https://idp.example", "user-"+suffix, "User")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(ctx, tenant.ID, "bench-"+suffix, "Workspace", user.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.CreateWorkspace(ctx, tenant.ID, "bench-"+suffix, "Duplicate", user.ID)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate (tenant, workbench) = %v, want conflict", err)
	}

	other, err := store.CreateTenant(ctx, "o-"+suffix, "Other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, other.ID, "bench-"+suffix, "Same key other tenant", user.ID); err != nil {
		t.Fatalf("same workbench_key in another tenant should be allowed: %v", err)
	}

	resolved, _, err := store.ResolveWorkspace(ctx, tenant.ID, tenant.Slug, ws.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ID != ws.ID {
		t.Fatalf("resolved %s want %s", resolved.ID, ws.ID)
	}
}

func TestPostgresCatalogMatchesAuthz(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := postgres.Open(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	store := NewPostgres(pool)
	roles, err := store.ListRoles(ctx)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{}
	for _, r := range authz.Roles() {
		want[r.Key] = append([]string(nil), r.Permissions...)
	}
	if len(roles) != len(want) {
		t.Fatalf("role count %d want %d", len(roles), len(want))
	}
	for _, r := range roles {
		got := map[string]bool{}
		for _, p := range r.Permissions {
			got[p] = true
		}
		for _, p := range want[r.Key] {
			if !got[p] {
				t.Fatalf("role %s missing permission %s", r.Key, p)
			}
		}
		if len(r.Permissions) != len(want[r.Key]) {
			t.Fatalf("role %s permission count %d want %d", r.Key, len(r.Permissions), len(want[r.Key]))
		}
	}
}

func TestMemoryRejectsPlatformAdminWorkspaceBinding(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	tenant, err := store.CreateTenant(ctx, "acme", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	admin, err := store.UpsertUser(ctx, "https://idp.example", "admin-1", "Admin")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(ctx, tenant.ID, "ops", "Ops", admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetMemberRoles(ctx, ws.ID, admin.ID, []string{authz.RolePlatformAdmin}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("platform-admin assignment: %v", err)
	}
	if err := store.SetMemberRoles(ctx, ws.ID, admin.ID, []string{authz.RoleAdmin, authz.RolePlatformAdmin}); !errors.Is(err, ErrInvalid) {
		t.Fatalf("mixed platform-admin assignment: %v", err)
	}
	roles, perms, err := store.EffectiveAccess(ctx, ws.ID, admin.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(roles, authz.RoleAdmin) {
		t.Fatalf("roles %v", roles)
	}
	if containsString(perms, authz.PermPlatformAdminister) {
		t.Fatalf("workspace admin must not receive platform.administer: %v", perms)
	}
}

func containsString(in []string, want string) bool {
	for _, v := range in {
		if v == want {
			return true
		}
	}
	return false
}

func TestMemoryUniqueTenantWorkbench(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	tenant, err := store.CreateTenant(ctx, "acme", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertUser(ctx, "https://idp.example", "u1", "U")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, tenant.ID, "ops", "Ops", user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, tenant.ID, "ops", "Ops 2", user.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("got %v", err)
	}
}
