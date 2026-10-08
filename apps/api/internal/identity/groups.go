package identity

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
)

// Workspace groups exist only to target approvals. A group never grants
// a permission, and membership never grants approval.decide. Groups are
// not nested and carry no roles or email. A group a workspace SCIM token
// created (SCIM_GROUPS_MODE=groups) carries managed_by 'scim' and the
// IdP's externalId; nothing else about it differs.

// ManagedBySCIM is workspace_groups.managed_by for a SCIM-managed group.
const ManagedBySCIM = "scim"

// MaxGroupNameLen is the display name limit in characters (runes).
const MaxGroupNameLen = 128

// Audit actions written to audit_events for group changes. Details carry
// ids only.
const (
	AuditGroupCreate       = "workspace_group.create"
	AuditGroupRename       = "workspace_group.rename"
	AuditGroupDelete       = "workspace_group.delete"
	AuditGroupMemberAdd    = "workspace_group.member_add"
	AuditGroupMemberRemove = "workspace_group.member_remove"
	// AuditGroupResource is audit_events.resource_type for group rows.
	AuditGroupResource = "workspace_group"
)

var (
	// ErrGroupNameInvalid is an empty, too long, or control-character
	// display name after trimming.
	ErrGroupNameInvalid = errors.New("invalid group display name")
	// ErrGroupNameTaken is a display name another group in the workspace
	// already holds, compared without regard to case. Both a pre-existing
	// row and a lost race on the unique index map here.
	ErrGroupNameTaken = errors.New("group name taken")
	// ErrGroupMemberNotInWorkspace is an add for a user who is unknown,
	// not active, or has no role binding in the workspace.
	ErrGroupMemberNotInWorkspace = errors.New("user is not an active workspace member")
	// ErrGroupManagedBySCIM refuses a local rename, member add or remove,
	// or delete of a group with managed_by 'scim' while the instance runs
	// SCIM_GROUPS_MODE=groups. Nothing changes.
	ErrGroupManagedBySCIM = errors.New("group is managed by SCIM")
	// ErrGroupExternalIDTaken is a SCIM create whose externalId another
	// group in the workspace already holds.
	ErrGroupExternalIDTaken = errors.New("group externalId taken")
)

// Group is one workspace group. MemberCount counts every membership row,
// including a disabled user who still has rows.
//
// ManagedBy is "scim" for a group a workspace SCIM token created and null
// for a local group. It is the stored marker: it stays when the instance
// switches back to SCIM_GROUPS_MODE=workspaces, where it is not enforced.
// ExternalID is the IdP's externalId; it is never serialized on the
// local API.
type Group struct {
	ID          string    `json:"id"`
	DisplayName string    `json:"displayName"`
	MemberCount int       `json:"memberCount"`
	ManagedBy   *string   `json:"managedBy"`
	ExternalID  string    `json:"-"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// GroupMember is one member row. CanApprove is true only when the user is
// active, has a live role binding in the workspace, and those roles grant
// approval.decide. It reports what roles already allow; membership adds
// nothing. No email is ever carried.
type GroupMember struct {
	UserID      string `json:"userId"`
	DisplayName string `json:"displayName"`
	CanApprove  bool   `json:"canApprove"`
}

// GroupDetail is a group plus every member row, ordered by display name
// without regard to case, then user id.
type GroupDetail struct {
	Group
	Members []GroupMember `json:"members"`
}

// GroupActor identifies who made a change, for created_by / added_by and
// the audit row. RequestID is the correlation id.
//
// SCIMTokenID is set (a UUID) only when a workspace SCIM token makes the
// change. The audit row then records the token id as the actor (details
// tokenId, via scim_token) and actor_id stays NULL. A SCIM actor can
// only touch groups with managed_by 'scim'; any other group is not found.
//
// SCIMGroupsMode is true while the instance runs SCIM_GROUPS_MODE=groups.
// A local actor (no SCIMTokenID) is then refused with
// ErrGroupManagedBySCIM on a managed group. Callers set it from the
// server settings on every request.
type GroupActor struct {
	UserID         string
	RequestID      string
	SCIMTokenID    string
	SCIMGroupsMode bool
}

// scim reports whether a workspace SCIM token is the actor.
func (a GroupActor) scim() bool {
	return authz.ValidUUID(strings.TrimSpace(a.SCIMTokenID))
}

// GroupStore manages workspace groups. workspaceID must come from the
// server-derived workspace after workspace.administer was checked. Every
// mutation writes its audit row in the same transaction, so a failed audit
// insert rolls the change back.
type GroupStore interface {
	ListGroupsPage(ctx context.Context, workspaceID string, q page.Query) ([]Group, string, error)
	CreateGroup(ctx context.Context, workspaceID string, actor GroupActor, displayName string) (Group, error)
	GetGroup(ctx context.Context, workspaceID, groupID string) (GroupDetail, error)
	RenameGroup(ctx context.Context, workspaceID string, actor GroupActor, groupID, displayName string) (Group, error)
	// DeleteGroup hard-deletes the group and its member rows.
	DeleteGroup(ctx context.Context, workspaceID string, actor GroupActor, groupID string) error
	// AddGroupMember is idempotent. The user must be active and bound in
	// the workspace.
	AddGroupMember(ctx context.Context, workspaceID string, actor GroupActor, groupID, userID string) error
	// RemoveGroupMember is idempotent.
	RemoveGroupMember(ctx context.Context, workspaceID string, actor GroupActor, groupID, userID string) error
}

// NormalizeGroupName trims and validates a display name.
func NormalizeGroupName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	n := utf8.RuneCountInString(name)
	if n < 1 || n > MaxGroupNameLen || !utf8.ValidString(name) {
		return "", ErrGroupNameInvalid
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return "", ErrGroupNameInvalid
		}
	}
	return name, nil
}

// memberCanApprove is the canApprove rule shared by both stores.
func memberCanApprove(status string, roleKeys []string) bool {
	if status != "active" || len(roleKeys) == 0 {
		return false
	}
	return authz.Allows(authz.ExpandWorkspaceRoles(roleKeys), authz.PermApprovalDecide)
}

// validGroupIDs keeps well-formed UUIDs only, lowercased and de-duplicated.
// A malformed id can never match a row, so dropping it fails closed.
func validGroupIDs(ids []string) []string {
	out := make([]string, 0, len(ids))
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		if !authz.ValidUUID(id) || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
