package identity

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Store persists tenants, workspaces, users, and RBAC bindings.
type Store interface {
	UpsertUser(ctx context.Context, issuer, subject, displayName string) (User, error)
	GetUser(ctx context.Context, id string) (User, error)

	CreateTenant(ctx context.Context, slug, name string) (Tenant, error)
	GetTenant(ctx context.Context, id string) (Tenant, error)
	GetTenantBySlug(ctx context.Context, slug string) (Tenant, error)

	CreateWorkspace(ctx context.Context, tenantID, workbenchKey, name, creatorUserID string) (Workspace, error)
	ResolveWorkspace(ctx context.Context, tenantID, tenantSlug, workbenchKey string) (Workspace, Tenant, error)
	GetWorkspace(ctx context.Context, id string) (Workspace, error)
	ListWorkspacesForUser(ctx context.Context, userID string) ([]Membership, error)

	ListRoles(ctx context.Context) ([]Role, error)
	ListPermissions(ctx context.Context) ([]Permission, error)

	EffectiveAccess(ctx context.Context, workspaceID, userID string) (roles, perms []string, err error)
	ListMembers(ctx context.Context, workspaceID string) ([]Member, error)
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
