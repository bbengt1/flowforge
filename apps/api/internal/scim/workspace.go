package scim

import (
	"context"
	"strings"
	"time"
	"unicode"
)

// Per-workspace SCIM. A workspace token resolves to one workspace, and
// every directory read and write for it runs in that workspace's scoped
// transaction. It never changes users.status, never revokes a session,
// and never touches another workspace.

// Audit actions written by the workspace directory.
const (
	AuditTokenCreate         = "scim_token.create"
	AuditTokenRevoke         = "scim_token.revoke"
	AuditUserWorkspaceAdd    = "scim_user.workspace_add"
	AuditUserDeactivate      = "scim_user.workspace_deactivate"
	AuditUserReactivate      = "scim_user.workspace_reactivate"
	AuditUserWorkspaceRemove = "scim_user.workspace_remove"
	AuditUserChangeIgnored   = "scim_user.change_ignored"

	AuditResourceToken = "scim_token"
	AuditResourceUser  = "scim_user"
)

// TokenCreator is the administrator who created a token: display name
// and UUID only.
type TokenCreator struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// Token is one workspace token row. It never carries the plaintext or
// the hash.
type Token struct {
	ID          string
	WorkspaceID string
	DisplayName string
	CreatedBy   *TokenCreator
	CreatedAt   time.Time
	LastUsedAt  *time.Time
	RevokedAt   *time.Time
}

// TokenScope is what an accepted workspace token authorizes.
type TokenScope struct {
	TokenID     string
	WorkspaceID string
	TenantID    string
}

// Actor is recorded on audit rows. UserID is empty for SCIM calls; the
// token id goes into the details instead.
type Actor struct {
	UserID    string
	RequestID string
	TokenID   string
}

// WorkspaceUser is a user as one workspace's SCIM directory shows it.
type WorkspaceUser struct {
	UserID        string
	UserName      string
	ExternalID    string
	DisplayName   string
	Status        string
	DeactivatedAt *time.Time
	// HasRole is whether the user holds any role binding in the
	// workspace right now.
	HasRole   bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Active is the SCIM active flag for a workspace token: the account is
// globally active, the link is not deactivated, and the user holds at
// least one role in the workspace. A link left behind after an admin
// removed the member, or after an instance-token disable, reads false.
func (u WorkspaceUser) Active() bool {
	return u.Status == "active" && u.DeactivatedAt == nil && u.HasRole
}

// ProvisionInput is a workspace-token POST /Users.
type ProvisionInput struct {
	Issuer      string
	Subject     string
	DisplayName string
	UserName    string
	ExternalID  string
	DefaultRole string
	Active      bool
}

// GroupMember is one member of the workspace Group.
type GroupMember struct {
	UserID      string
	DisplayName string
}

// WorkspaceGroup is the one Group a workspace token sees.
type WorkspaceGroup struct {
	ID           string
	Name         string
	WorkbenchKey string
	Members      []GroupMember
}

// WorkspaceDirectory stores workspace tokens and per-workspace SCIM
// links. Implementations must run link and membership changes in one
// workspace-scoped transaction.
type WorkspaceDirectory interface {
	CreateToken(ctx context.Context, workspaceID string, actor Actor, displayName string, now time.Time) (Token, string, error)
	ListTokens(ctx context.Context, workspaceID string) ([]Token, error)
	RevokeToken(ctx context.Context, workspaceID, tokenID string, actor Actor, now time.Time) error
	Authenticate(ctx context.Context, presented string, now time.Time) (TokenScope, error)

	ListUsers(ctx context.Context, scope TokenScope, attr, value string, startIndex, count int) ([]WorkspaceUser, int, error)
	GetUser(ctx context.Context, scope TokenScope, userID string) (WorkspaceUser, error)
	ProvisionUser(ctx context.Context, scope TokenScope, in ProvisionInput, actor Actor, now time.Time) (WorkspaceUser, error)
	UpdateUser(ctx context.Context, scope TokenScope, userID string, ch UserChange, defaultRole string, actor Actor, now time.Time) (WorkspaceUser, error)
	RemoveUser(ctx context.Context, scope TokenScope, userID string, actor Actor) error
	GetGroup(ctx context.Context, scope TokenScope) (WorkspaceGroup, error)
	PatchGroup(ctx context.Context, scope TokenScope, ch GroupChange, defaultRole string, actor Actor, now time.Time) (WorkspaceGroup, error)

	// SCIM_GROUPS_MODE=groups: managed Flowforge groups in the token's
	// workspace.
	ListManagedGroups(ctx context.Context, scope TokenScope, attr, value string, startIndex, count int) ([]ManagedGroup, int, error)
	GetManagedGroup(ctx context.Context, scope TokenScope, groupID string) (ManagedGroup, error)
	CreateManagedGroup(ctx context.Context, scope TokenScope, in ManagedGroupWrite, actor Actor, now time.Time) (ManagedGroup, error)
	ReplaceManagedGroup(ctx context.Context, scope TokenScope, groupID string, in ManagedGroupWrite, actor Actor, now time.Time) (ManagedGroup, error)
	PatchManagedGroup(ctx context.Context, scope TokenScope, groupID string, ch ManagedGroupPatch, actor Actor, now time.Time) (ManagedGroup, error)
	DeleteManagedGroup(ctx context.Context, scope TokenScope, groupID string, actor Actor, now time.Time) error
}

// NormalizeTokenName trims a token display name and validates it: 1-128
// characters, no control characters.
func NormalizeTokenName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > 128 {
		return "", ErrInvalid
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", ErrInvalid
		}
	}
	return name, nil
}
