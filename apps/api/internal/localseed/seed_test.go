package localseed

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

// DocumentedComposeKEK is the local-only compose default (32-byte ASCII
// "flowforge-local-dev-kek-32bytes!" as standard base64). Never a
// production value. The constant exists so a typo cannot ship.
const DocumentedComposeKEK = "Zmxvd2ZvcmdlLWxvY2FsLWRldi1rZWstMzJieXRlcyE="

func TestDocumentedComposeKEKIsReady(t *testing.T) {
	t.Setenv(vault.EnvKEK, DocumentedComposeKEK)
	t.Setenv(vault.EnvKEKFile, "")
	t.Setenv(vault.EnvKEKID, "local:compose")
	keys, err := vault.LoadKeys()
	if err != nil {
		t.Fatal(err)
	}
	if !keys.Ready() || keys.ID != "local:compose" {
		t.Fatalf("compose KEK must load as a 32-byte local key, got ready=%v id=%q", keys.Ready(), keys.ID)
	}
}

func TestResolveLocalSeedGate(t *testing.T) {
	cases := []struct {
		name       string
		flag       string
		appEnv     string
		requireTLS bool
		want       bool
		wantErr    bool
	}{
		{name: "empty production", want: false},
		{name: "production unset flag", appEnv: "production", want: false},
		{name: "unknown env", appEnv: "staging", want: false},
		{name: "development default on", appEnv: "development", want: true},
		{name: "dev default on", appEnv: "dev", want: true},
		{name: "local default on", appEnv: "local", want: true},
		{name: "test default on", appEnv: "test", want: true},
		{name: "development explicit on", flag: "1", appEnv: "development", want: true},
		{name: "development opt out", flag: "0", appEnv: "development", want: false},
		{name: "development false", flag: "false", appEnv: "development", want: false},
		{name: "development with tls", appEnv: "development", requireTLS: true, want: false},
		{name: "explicit on production", flag: "1", appEnv: "production", wantErr: true},
		{name: "explicit on empty env", flag: "true", appEnv: "", wantErr: true},
		{name: "explicit on with tls", flag: "1", appEnv: "development", requireTLS: true, wantErr: true},
		{name: "explicit off production", flag: "0", appEnv: "production", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Resolve(tc.flag, tc.appEnv, tc.requireTLS)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got enabled=%v", got)
				}
				if got {
					t.Fatal("error path must not enable seed")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("enabled = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestApplySeedsTenantWorkspaceCredentials(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	keys := vault.TestKeys()
	vlt := vault.NewMemory(keys, nil)
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}}

	res, err := Apply(ctx, Input{
		Store:          store,
		Vault:          vlt,
		Keys:           keys,
		PlatformAdmins: admins,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !res.Created || res.Tenant.Slug != TenantSlug || res.Workspace.WorkbenchKey != WorkbenchKey {
		t.Fatalf("first seed %+v", res)
	}
	if len(res.Users) != 1 || res.Users[0].ExternalSubject != "admin-1" {
		t.Fatalf("users %+v", res.Users)
	}
	if res.CredentialCount != 3 {
		t.Fatalf("credentials = %d, want 3", res.CredentialCount)
	}

	memberships, err := store.ListWorkspacesForUser(ctx, res.Users[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 || memberships[0].Workspace.ID != res.Workspace.ID {
		t.Fatalf("memberships %+v", memberships)
	}
	if !slices.Contains(memberships[0].Roles, authz.RoleAdmin) {
		t.Fatalf("roles %v", memberships[0].Roles)
	}

	scope, err := isolation.AuthorizeTenancy(res.Workspace.ID, res.Users[0].ID, res.Tenant.ID, res.Workspace.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}
	items, err := vlt.List(ctx, scope)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 3 {
		t.Fatalf("listed %d credentials", len(items))
	}
	plain, err := vlt.Unlock(ctx, scope, items[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(plain) == 0 {
		t.Fatal("unlock returned empty plaintext")
	}
}

func TestApplyIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	keys := vault.TestKeys()
	vlt := vault.NewMemory(keys, nil)
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
		t.Fatal("second run must not create duplicates")
	}
	if first.Tenant.ID != second.Tenant.ID || first.Workspace.ID != second.Workspace.ID {
		t.Fatal("second run must reuse tenant/workspace")
	}
	if len(second.Credentials) != len(first.Credentials) {
		t.Fatalf("credential count first=%d second=%d", len(first.Credentials), len(second.Credentials))
	}
	seen := map[string]int{}
	for _, item := range second.Credentials {
		seen[item.DisplayName]++
	}
	for name, n := range seen {
		if n != 1 {
			t.Fatalf("credential %q listed %d times", name, n)
		}
	}

	memberships, err := store.ListWorkspacesForUser(ctx, first.Users[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 {
		t.Fatalf("duplicate memberships: %d", len(memberships))
	}
}

func TestApplySkipsCredentialsWithoutKEK(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	res, err := Apply(ctx, Input{
		Store:          store,
		Vault:          vault.NewMemory(vault.Keys{}, nil),
		Keys:           vault.Keys{},
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Tenant.Slug != TenantSlug || res.Workspace.WorkbenchKey != WorkbenchKey {
		t.Fatalf("identity still required %+v", res)
	}
	if res.CredentialCount != 0 || res.CredentialNote == "" {
		t.Fatalf("expected credential skip, got %+v", res)
	}
}

func TestApplyNoopsWithoutPlatformAdmins(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	res, err := Apply(ctx, Input{Store: store})
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped == "" {
		t.Fatal("empty PLATFORM_ADMINS must skip")
	}
	if _, err := store.GetTenantBySlug(ctx, TenantSlug); !errors.Is(err, identity.ErrNotFound) {
		t.Fatalf("must not invent a tenant: %v", err)
	}
}

func TestApplyAttachesExistingWorkspaceAdmin(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	tenant, err := store.CreateTenant(ctx, TenantSlug, "Already here")
	if err != nil {
		t.Fatal(err)
	}
	other, err := store.UpsertUser(ctx, "https://idp.example", "other-1", "Other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, tenant.ID, WorkbenchKey, "Existing", other.ID); err != nil {
		t.Fatal(err)
	}

	res, err := Apply(ctx, Input{
		Store:          store,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.CreatedWorkspace {
		t.Fatal("must reuse existing workbench")
	}
	if res.Tenant.ID != tenant.ID {
		t.Fatal("must reuse existing tenant")
	}
	roles, perms, err := store.EffectiveAccess(ctx, res.Workspace.ID, res.Users[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if !authz.Allows(perms, authz.PermWorkspaceAdminister) {
		t.Fatalf("admin-1 must be workspace admin, roles=%v", roles)
	}
}
