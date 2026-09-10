// Package localseed installs a default tenant, workbench, and demo
// vault credentials for local/dev compose. Production-locked processes
// never run this path (ADV-002 stay fail-closed).
package localseed

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Environment source for the explicit local-seed gate.
const EnvSeedLocalDefaults = "SEED_LOCAL_DEFAULTS"

// Documented local-only identities. These are not production values.
const (
	TenantSlug     = "local"
	TenantName     = "Local demo"
	WorkbenchKey   = "default"
	WorkspaceName  = "Local workbench"
	AdminDisplay   = "Local platform admin"
	CredentialTag  = "local-demo"
	TokenName      = "Local demo token"
	WebhookName    = "Local demo webhook"
	ProviderName   = "Local demo provider"
	TokenSecret    = "local-demo-token-not-a-secret"
	WebhookSecret  = "local-demo-webhook-not-a-secret"
	ProviderSecret = "local-demo-provider-not-a-secret"
)

// Input is the seed dependency set. Tests inject memory stores.
type Input struct {
	Store          identity.Store
	Vault          vault.Store
	Keys           vault.Keys
	PlatformAdmins []authz.PrincipalRef
	Log            *slog.Logger
}

// Result is a secret-free summary of what the seed did.
type Result struct {
	Tenant           identity.Tenant
	Workspace        identity.Workspace
	Users            []identity.User
	Credentials      []vault.Metadata
	Created          bool
	Skipped          string
	CredentialNote   string
	CredentialCount  int
	CreatedTenant    bool
	CreatedWorkspace bool
}

// Resolve decides whether local defaults should be seeded.
//
// Enabled when APP_ENV is development|dev|local|test, REQUIRE_TLS is
// false, and SEED_LOCAL_DEFAULTS is not an explicit off value.
// Production-locked APP_ENV or REQUIRE_TLS=true is a no-op unless the
// flag is explicitly on, in which case config load refuses to start so
// the leftover cannot stay enabled accidentally.
func Resolve(flag, appEnv string, requireTLS bool) (bool, error) {
	on := truthyEnv(flag)
	if authz.ProductionLocked(appEnv, requireTLS) {
		if on {
			return false, fmt.Errorf("%s cannot be enabled when %s is empty/production/unknown or REQUIRE_TLS=true", EnvSeedLocalDefaults, authz.EnvAppEnv)
		}
		return false, nil
	}
	if falsyEnv(flag) {
		return false, nil
	}
	return true, nil
}

// Hook returns a postgres.Pool AfterReady callback that seeds using the
// live app pool. Store/Vault on in are ignored; they are constructed
// from the pool so RLS and grants match the API process.
func Hook(in Input) func(context.Context, *pgxpool.Pool) error {
	return func(ctx context.Context, db *pgxpool.Pool) error {
		if db == nil {
			return fmt.Errorf("local seed: postgres pool is nil")
		}
		in.Store = identity.NewPostgres(db)
		in.Vault = vault.NewPostgres(db, in.Keys, nil)
		res, err := Apply(ctx, in)
		if err != nil {
			return err
		}
		log := logger(in.Log)
		if res.Skipped != "" {
			log.Info("local defaults seed skipped", "reason", res.Skipped)
			return nil
		}
		log.Info("local defaults seeded",
			"tenant_slug", TenantSlug,
			"workbench_key", WorkbenchKey,
			"created", res.Created,
			"credentials", res.CredentialCount,
			"credential_note", res.CredentialNote,
		)
		return nil
	}
}

// Apply is idempotent. A second call with the same stores must not
// create a duplicate tenant, workspace, membership, or demo credential.
func Apply(ctx context.Context, in Input) (Result, error) {
	if in.Store == nil {
		return Result{}, fmt.Errorf("local seed: identity store is required")
	}
	if len(in.PlatformAdmins) == 0 {
		return Result{Skipped: "PLATFORM_ADMINS is empty"}, nil
	}

	var res Result
	tenant, createdTenant, err := ensureTenant(ctx, in.Store)
	if err != nil {
		return Result{}, err
	}
	res.Tenant = tenant
	res.CreatedTenant = createdTenant
	res.Created = createdTenant

	users, err := ensureUsers(ctx, in.Store, in.PlatformAdmins)
	if err != nil {
		return Result{}, err
	}
	res.Users = users
	if len(users) == 0 {
		return Result{Skipped: "PLATFORM_ADMINS had no valid principals"}, nil
	}

	ws, createdWS, err := ensureWorkspace(ctx, in.Store, tenant, users[0].ID)
	if err != nil {
		return Result{}, err
	}
	res.Workspace = ws
	res.CreatedWorkspace = createdWS
	if createdWS {
		res.Created = true
	}

	for _, user := range users {
		added, err := ensureAdminMember(ctx, in.Store, ws.ID, user)
		if err != nil {
			return Result{}, err
		}
		if added {
			res.Created = true
		}
	}

	if err := seedCredentials(ctx, in, tenant, ws, users[0], &res); err != nil {
		return Result{}, err
	}
	return res, nil
}

func ensureTenant(ctx context.Context, store identity.Store) (identity.Tenant, bool, error) {
	existing, err := store.GetTenantBySlug(ctx, TenantSlug)
	if err == nil {
		return existing, false, nil
	}
	if !errors.Is(err, identity.ErrNotFound) {
		return identity.Tenant{}, false, err
	}
	tenant, err := store.CreateTenant(ctx, TenantSlug, TenantName)
	if err == nil {
		return tenant, true, nil
	}
	if errors.Is(err, identity.ErrConflict) {
		existing, err = store.GetTenantBySlug(ctx, TenantSlug)
		return existing, false, err
	}
	return identity.Tenant{}, false, err
}

func ensureUsers(ctx context.Context, store identity.Store, admins []authz.PrincipalRef) ([]identity.User, error) {
	var out []identity.User
	for _, ref := range admins {
		user, err := store.UpsertUser(ctx, ref.Issuer, ref.Subject, AdminDisplay)
		if err != nil {
			return nil, err
		}
		out = append(out, user)
	}
	return out, nil
}

func ensureWorkspace(ctx context.Context, store identity.Store, tenant identity.Tenant, creatorID string) (identity.Workspace, bool, error) {
	ws, _, err := store.ResolveWorkspace(ctx, tenant.ID, tenant.Slug, WorkbenchKey)
	if err == nil {
		return ws, false, nil
	}
	if !errors.Is(err, identity.ErrNotFound) {
		return identity.Workspace{}, false, err
	}
	ws, err = store.CreateWorkspace(ctx, tenant.ID, WorkbenchKey, WorkspaceName, creatorID)
	if err == nil {
		return ws, true, nil
	}
	if errors.Is(err, identity.ErrConflict) {
		ws, _, err = store.ResolveWorkspace(ctx, tenant.ID, tenant.Slug, WorkbenchKey)
		return ws, false, err
	}
	return identity.Workspace{}, false, err
}

func ensureAdminMember(ctx context.Context, store identity.Store, workspaceID string, user identity.User) (bool, error) {
	roles, perms, err := store.EffectiveAccess(ctx, workspaceID, user.ID)
	if err != nil && !errors.Is(err, identity.ErrNotFound) {
		return false, err
	}
	if authz.Allows(perms, authz.PermWorkspaceAdminister) {
		return false, nil
	}
	next := append(append([]string{}, roles...), authz.RoleAdmin)
	if err := store.SetMemberRoles(ctx, workspaceID, user.ID, next); err != nil {
		return false, err
	}
	return true, nil
}

func seedCredentials(ctx context.Context, in Input, tenant identity.Tenant, ws identity.Workspace, actor identity.User, res *Result) error {
	if in.Vault == nil || !in.Keys.Ready() {
		res.CredentialNote = "CREDENTIAL_KEK is unset; demo credentials were not created"
		return nil
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, actor.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		return err
	}
	existing, err := in.Vault.List(ctx, scope)
	if err != nil {
		return err
	}
	seen := map[string]vault.Metadata{}
	for _, item := range existing {
		seen[item.DisplayName] = item
	}
	for _, spec := range demoCredentials() {
		if item, ok := seen[spec.DisplayName]; ok {
			res.Credentials = append(res.Credentials, item)
			continue
		}
		created, err := in.Vault.Create(ctx, scope, spec)
		if err != nil {
			return err
		}
		res.Credentials = append(res.Credentials, created)
		res.Created = true
	}
	res.CredentialCount = len(res.Credentials)
	return nil
}

func demoCredentials() []vault.CreateInput {
	return []vault.CreateInput{
		{
			Type:        vault.TypeToken,
			DisplayName: TokenName,
			Tags:        []string{CredentialTag},
			Metadata:    map[string]string{"tokenKind": "local-demo", "source": "compose-seed"},
			Secret:      map[string]string{"token": TokenSecret},
		},
		{
			Type:        vault.TypeWebhookSecret,
			DisplayName: WebhookName,
			Tags:        []string{CredentialTag},
			Metadata:    map[string]string{"source": "compose-seed"},
			Secret:      map[string]string{"secret": WebhookSecret},
		},
		{
			Type:        vault.TypeProvider,
			DisplayName: ProviderName,
			Tags:        []string{CredentialTag},
			Metadata:    map[string]string{"provider": "local-demo", "source": "compose-seed"},
			Secret:      map[string]string{"token": ProviderSecret},
		},
	}
}

func logger(log *slog.Logger) *slog.Logger {
	if log != nil {
		return log
	}
	return slog.Default()
}

func truthyEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func falsyEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "0", "false", "no", "off":
		return true
	default:
		return false
	}
}
