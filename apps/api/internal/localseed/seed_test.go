package localseed

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
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

func TestApplyMarksBootstrapCompleteWhenAdminAndURLExist(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	boot := bootstrap.NewMemory()
	if _, err := Apply(ctx, Input{
		Store:          store,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
		Bootstrap:      boot,
		PublicBaseURL:  "http://localhost:3000",
	}); err != nil {
		t.Fatal(err)
	}
	st, err := boot.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !st.Complete || !st.Skipped || !st.FirstAdminReady || !st.PublicURLReady {
		t.Fatalf("seed must skip wizard: %+v", st)
	}
	if st.PublicBaseURL != "http://localhost:3000" {
		t.Fatalf("stored URL = %q", st.PublicBaseURL)
	}
	status := st.Status()
	if !status.Complete || status.Incomplete {
		t.Fatalf("status %+v", status)
	}

	if _, err := Apply(ctx, Input{
		Store:          store,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
		Bootstrap:      boot,
		PublicBaseURL:  "http://other.example",
	}); err != nil {
		t.Fatal(err)
	}
	st, err = boot.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.PublicBaseURL != "http://localhost:3000" {
		t.Fatalf("idempotent seed must not replace URL: %q", st.PublicBaseURL)
	}
}

func TestProvisionAdminCreatesWorkspaceAdmin(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()

	user, err := ProvisionAdmin(ctx, store, "https://idp.example", "admin-1", "Operator")
	if err != nil {
		t.Fatal(err)
	}
	if user.ExternalSubject != "admin-1" || user.DisplayName != "Operator" {
		t.Fatalf("user %+v", user)
	}
	memberships, err := store.ListWorkspacesForUser(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 || memberships[0].Workspace.WorkbenchKey != WorkbenchKey {
		t.Fatalf("memberships %+v", memberships)
	}
	if memberships[0].Tenant.Slug != TenantSlug {
		t.Fatalf("tenant slug = %q, want %q", memberships[0].Tenant.Slug, TenantSlug)
	}
	if !authz.Allows(memberships[0].Permissions, authz.PermWorkspaceAdminister) {
		t.Fatalf("must be workspace admin, roles=%v", memberships[0].Roles)
	}
	again, err := ProvisionAdmin(ctx, store, "https://idp.example", "admin-1", "Operator")
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != user.ID {
		t.Fatal("second provision must reuse the user")
	}
	after, err := store.ListWorkspacesForUser(ctx, again.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 {
		t.Fatalf("idempotent provision must not duplicate memberships: %d", len(after))
	}
}

func TestProvisionAdminAfterApplyIsIdempotent(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	res, err := Apply(ctx, Input{
		Store:          store,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	user, err := ProvisionAdmin(ctx, store, "https://idp.example", "admin-1", "Local platform admin")
	if err != nil {
		t.Fatal(err)
	}
	if user.ID != res.Users[0].ID {
		t.Fatal("path-1 seed then B.3 must reuse the same user")
	}
	memberships, err := store.ListWorkspacesForUser(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 || memberships[0].Workspace.ID != res.Workspace.ID {
		t.Fatalf("path-1 create-or-bind must reuse local/default: %+v", memberships)
	}
}

func TestApplyNoopsWithoutPlatformAdmins(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	boot := bootstrap.NewMemory()
	res, err := Apply(ctx, Input{Store: store, Bootstrap: boot})
	if err != nil {
		t.Fatal(err)
	}
	if res.Skipped == "" {
		t.Fatal("empty PLATFORM_ADMINS must skip")
	}
	st, err := boot.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if st.Complete {
		t.Fatal("empty PLATFORM_ADMINS must not mark bootstrap complete")
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

func TestEnsureBootstrapLoginSeedsOnlyWhenEmpty(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	if err := EnsureBootstrapLogin(ctx, store, nil); err != nil {
		t.Fatal(err)
	}
	login, err := store.LookupLocalLogin(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if login.User.Issuer != BootstrapIssuer || login.User.ExternalSubject != BootstrapSubject {
		t.Fatalf("bootstrap user %+v", login.User)
	}
	if !login.MustChangePassword || login.PasswordHash == "" {
		t.Fatalf("must_change + hash required: %+v", login)
	}
	if login.PasswordHash == "admin" {
		t.Fatal("must store a hash, not the one-time password")
	}
	memberships, err := store.ListWorkspacesForUser(ctx, login.User.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 || memberships[0].Tenant.Slug != TenantSlug || memberships[0].Workspace.WorkbenchKey != WorkbenchKey {
		t.Fatalf("workbench %+v", memberships)
	}

	firstHash := login.PasswordHash
	if err := EnsureBootstrapLogin(ctx, store, nil); err != nil {
		t.Fatal(err)
	}
	again, err := store.LookupLocalLogin(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if again.PasswordHash != firstHash || !again.MustChangePassword {
		t.Fatalf("second seed must not overwrite: %+v", again)
	}
}

func TestEnsureBootstrapLoginDoesNotOverwriteExisting(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	user, err := store.UpsertUser(ctx, "https://idp.example", "ops@example.com", "Ops")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(ctx, user.ID, "ops@example.com", "$2a$10$already-set"); err != nil {
		t.Fatal(err)
	}
	if err := EnsureBootstrapLogin(ctx, store, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LookupLocalLogin(ctx, "admin"); !errors.Is(err, identity.ErrNotFound) {
		t.Fatalf("must not invent admin when a credential exists: %v", err)
	}
	got, err := store.LookupLocalLogin(ctx, "ops@example.com")
	if err != nil {
		t.Fatal(err)
	}
	if got.PasswordHash != "$2a$10$already-set" || got.MustChangePassword {
		t.Fatalf("existing credential changed: %+v", got)
	}
}

func TestLocalseedApplyDoesNotCreateLocalLogin(t *testing.T) {
	ctx := context.Background()
	store := identity.NewMemory()
	if _, err := Apply(ctx, Input{
		Store:          store,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "admin-1"}},
	}); err != nil {
		t.Fatal(err)
	}
	has, err := store.HasLocalLogins(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if has {
		t.Fatal("PLATFORM_ADMINS / localseed must not create a local-login password")
	}
}
