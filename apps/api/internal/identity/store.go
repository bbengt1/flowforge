package identity

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
)

// Store persists tenants, workspaces, users, and RBAC bindings.
type Store interface {
	UpsertUser(ctx context.Context, issuer, subject, displayName string) (User, error)
	GetUser(ctx context.Context, id string) (User, error)
	// SetUserStatus sets users.status to active or disabled. Revoked
	// machine principals are disabled so existing sessions fail closed.
	SetUserStatus(ctx context.Context, userID, status string) error
	// FindUser returns an existing principal. It does not upsert.
	FindUser(ctx context.Context, issuer, subject string) (User, error)
	// SetLocalPassword stores a bcrypt hash for local login. identifier
	// is the already-normalized email or username. The hash is never
	// copied onto User JSON. Operator-chosen passwords clear
	// must_change_password (B.3).
	SetLocalPassword(ctx context.Context, userID, identifier, passwordHash string) error
	// LookupLocalLogin finds a credential by normalized identifier.
	// PasswordHash is returned only for Verify; callers must not serialize it.
	LookupLocalLogin(ctx context.Context, identifier string) (LocalLogin, error)
	// LookupLocalLoginByUser finds a credential by user id.
	LookupLocalLoginByUser(ctx context.Context, userID string) (LocalLogin, error)
	// HasLocalLogins is true when at least one local credential exists.
	HasLocalLogins(ctx context.Context) (bool, error)
	// InsertBootstrapLocalLogin inserts the first-run one-time credential
	// only when the table is empty. Never updates an existing row.
	InsertBootstrapLocalLogin(ctx context.Context, userID, identifier, passwordHash string) (created bool, err error)
	// ChangeLocalPassword replaces the hash for userID and clears
	// must_change_password. Missing login is ErrNotFound.
	ChangeLocalPassword(ctx context.Context, userID, passwordHash string) error

	CreateTenant(ctx context.Context, slug, name string) (Tenant, error)
	GetTenant(ctx context.Context, id string) (Tenant, error)
	GetTenantBySlug(ctx context.Context, slug string) (Tenant, error)

	CreateWorkspace(ctx context.Context, tenantID, workbenchKey, name, creatorUserID string) (Workspace, error)
	ResolveWorkspace(ctx context.Context, tenantID, tenantSlug, workbenchKey string) (Workspace, Tenant, error)
	GetWorkspace(ctx context.Context, id string) (Workspace, error)
	DeleteWorkspace(ctx context.Context, id string) (Workspace, error)
	ListWorkspacesForUser(ctx context.Context, userID string) ([]Membership, error)
	ListWorkspacesForUserPage(ctx context.Context, userID string, q page.Query) ([]Membership, string, error)
	// ListActiveWorkspaces returns workspaces whose tenant is also active.
	// Identity tables are unscoped so membership can be checked before
	// app.workspace_id is set. Callers that then touch workspace-owned
	// rows must still set that scope (FORCE RLS). Disabled rows are omitted.
	ListActiveWorkspaces(ctx context.Context) ([]Workspace, error)

	ListRoles(ctx context.Context) ([]Role, error)
	ListPermissions(ctx context.Context) ([]Permission, error)

	EffectiveAccess(ctx context.Context, workspaceID, userID string) (roles, perms []string, err error)
	ListMembers(ctx context.Context, workspaceID string) ([]Member, error)
	ListMembersPage(ctx context.Context, workspaceID string, q page.Query) ([]Member, string, error)
	SetMemberRoles(ctx context.Context, workspaceID, userID string, roleKeys []string) error
	RemoveMember(ctx context.Context, workspaceID, userID string) error
	ResolveUserRef(ctx context.Context, userID, issuer, subject, displayName string) (User, error)
}

// CatalogRoles converts the in-process matrix into store roles.
func CatalogRoles() []Role {
	src := authz.Roles()
	out := make([]Role, 0, len(src))
	for _, r := range src {
		out = append(out, Role{Key: r.Key, Description: r.Description, Permissions: append([]string(nil), r.Permissions...)})
	}
	return out
}

// CatalogPermissions converts the in-process matrix into store permissions.
func CatalogPermissions() []Permission {
	src := authz.Permissions()
	out := make([]Permission, 0, len(src))
	for _, p := range src {
		out = append(out, Permission{Key: p.Key})
	}
	return out
}
