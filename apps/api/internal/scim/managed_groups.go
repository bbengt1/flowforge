package scim

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/jackc/pgx/v5"
)

// SCIM_GROUPS_MODE=groups. A workspace token manages Flowforge groups
// (workspace_groups with managed_by 'scim') in its own workspace only.
// Every write goes through the identity group functions, the same code
// as the local group API, so a SCIM delete or member removal re-checks
// waiting approval gates exactly like a local one. Group member changes
// write group rows only: they never add or remove roles or workspace
// membership. Workspace membership comes only from /Users.
//
// A token sees only managed groups, and within them only members its
// workspace's IdP linked. A local group is not found.

// ErrUniqueness is a create or rename whose displayName (compared
// without regard to case) or externalId another group in the workspace
// already holds. Neither group is renamed. SCIM 409 uniqueness.
var ErrUniqueness = errors.New("scim group name or externalId taken")

// ErrMemberNotEligible is a member add for a user this workspace's IdP
// did not link, whose link is deactivated, or who is not an active
// member of the workspace. SCIM 400.
var ErrMemberNotEligible = errors.New("scim group member is not an active linked workspace member")

// ManagedGroup is a managed group as a workspace token sees it. Members
// are linked users only.
type ManagedGroup struct {
	ID          string
	DisplayName string
	ExternalID  string
	Members     []GroupMember
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func groupActor(scope TokenScope, actor Actor) identity.GroupActor {
	return identity.GroupActor{RequestID: actor.RequestID, SCIMTokenID: scope.TokenID, SCIMGroupsMode: true}
}

const managedGroupColumns = `g.id::text, g.display_name, COALESCE(g.external_id, ''), g.created_at, g.updated_at`

func (p *WorkspacePostgres) ListManagedGroups(ctx context.Context, scope TokenScope, attr, value string, startIndex, count int) ([]ManagedGroup, int, error) {
	where := ""
	args := []any{scope.WorkspaceID}
	switch attr {
	case "":
	case "displayName":
		where = " AND lower(g.display_name) = lower($2)"
		args = append(args, strings.TrimSpace(value))
	case "externalId":
		where = " AND g.external_id = $2"
		args = append(args, value)
	case "id":
		if !authz.ValidUUID(value) {
			return []ManagedGroup{}, 0, nil
		}
		where = " AND g.id = $2::uuid"
		args = append(args, value)
	default:
		return nil, 0, ErrInvalid
	}
	if startIndex < 1 {
		startIndex = 1
	}
	out := []ManagedGroup{}
	total := 0
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx, `
			SELECT count(*) FROM workspace_groups g
			 WHERE g.workspace_id = $1::uuid AND g.managed_by = 'scim'`+where, args...).Scan(&total); err != nil {
			return mapWorkspaceErr(err)
		}
		if count <= 0 {
			return nil
		}
		n := len(args)
		pageArgs := append(append([]any{}, args...), count, startIndex-1)
		rows, err := tx.Query(ctx, `
			SELECT `+managedGroupColumns+`
			  FROM workspace_groups g
			 WHERE g.workspace_id = $1::uuid AND g.managed_by = 'scim'`+where+`
			 ORDER BY g.created_at, g.id
			 LIMIT $`+strconv.Itoa(n+1)+` OFFSET $`+strconv.Itoa(n+2), pageArgs...)
		if err != nil {
			return mapWorkspaceErr(err)
		}
		for rows.Next() {
			var g ManagedGroup
			if err := rows.Scan(&g.ID, &g.DisplayName, &g.ExternalID, &g.CreatedAt, &g.UpdatedAt); err != nil {
				rows.Close()
				return mapWorkspaceErr(err)
			}
			out = append(out, g)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return mapWorkspaceErr(err)
		}
		for i := range out {
			members, err := linkedGroupMembers(ctx, tx, scope.WorkspaceID, out[i].ID)
			if err != nil {
				return err
			}
			out[i].Members = members
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	return out, total, nil
}

func (p *WorkspacePostgres) GetManagedGroup(ctx context.Context, scope TokenScope, groupID string) (ManagedGroup, error) {
	if !authz.ValidUUID(groupID) {
		return ManagedGroup{}, ErrNotFound
	}
	var out ManagedGroup
	err := p.scoped(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		g, err := loadManagedGroup(ctx, tx, scope.WorkspaceID, groupID)
		out = g
		return err
	})
	return out, err
}

// CreateManagedGroup creates a managed group and adds its members, in one
// transaction. A displayName or externalId clash is ErrUniqueness and
// nothing is created; the local group is never renamed.
func (p *WorkspacePostgres) CreateManagedGroup(ctx context.Context, scope TokenScope, in ManagedGroupWrite, actor Actor, now time.Time) (ManagedGroup, error) {
	if len(in.ExternalID) > 256 {
		return ManagedGroup{}, ErrInvalid
	}
	if _, err := identity.NormalizeGroupName(in.DisplayName); err != nil {
		return ManagedGroup{}, ErrInvalid
	}
	var out ManagedGroup
	err := p.scopedMembership(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		ga := groupActor(scope, actor)
		g, err := identity.CreateGroupTx(ctx, tx, scope.WorkspaceID, ga, in.DisplayName, in.ExternalID)
		if err != nil {
			return mapGroupIdentityErr(err)
		}
		if err := addManagedMembers(ctx, tx, scope, ga, g.ID, in.Members); err != nil {
			return err
		}
		out, err = loadManagedGroup(ctx, tx, scope.WorkspaceID, g.ID)
		return err
	})
	return out, err
}

// ReplaceManagedGroup is PUT: the display name follows the IdP, and when
// the body has a members attribute the linked members become exactly
// in.Members. Removals run first, then the rename, then adds. externalId
// is never rewritten.
func (p *WorkspacePostgres) ReplaceManagedGroup(ctx context.Context, scope TokenScope, groupID string, in ManagedGroupWrite, actor Actor, now time.Time) (ManagedGroup, error) {
	name := in.DisplayName
	return p.patchManaged(ctx, scope, groupID, ManagedGroupPatch{DisplayName: &name, ReplaceMembers: in.MembersSet, Members: in.Members}, actor, now)
}

// PatchManagedGroup applies a PatchOp.
func (p *WorkspacePostgres) PatchManagedGroup(ctx context.Context, scope TokenScope, groupID string, ch ManagedGroupPatch, actor Actor, now time.Time) (ManagedGroup, error) {
	return p.patchManaged(ctx, scope, groupID, ch, actor, now)
}

func (p *WorkspacePostgres) patchManaged(ctx context.Context, scope TokenScope, groupID string, ch ManagedGroupPatch, actor Actor, now time.Time) (ManagedGroup, error) {
	if !authz.ValidUUID(groupID) {
		return ManagedGroup{}, ErrNotFound
	}
	if ch.DisplayName != nil {
		if _, err := identity.NormalizeGroupName(*ch.DisplayName); err != nil {
			return ManagedGroup{}, ErrInvalid
		}
	}
	var out ManagedGroup
	// The workspace-row lock serializes this with every membership-loss
	// path. Removals (which lock waiting gates, then group rows) run
	// before the rename and the adds, so this transaction takes gates,
	// group rows, then binding share locks, in that order.
	err := p.scopedMembership(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		cur, err := loadManagedGroup(ctx, tx, scope.WorkspaceID, groupID)
		if err != nil {
			return err
		}
		ga := groupActor(scope, actor)
		add, remove := ch.Add, ch.Remove
		if ch.ReplaceMembers {
			want := map[string]bool{}
			for _, id := range ch.Members {
				want[strings.ToLower(strings.TrimSpace(id))] = true
			}
			have := map[string]bool{}
			remove = nil
			for _, m := range cur.Members {
				have[m.UserID] = true
				if !want[m.UserID] {
					remove = append(remove, m.UserID)
				}
			}
			add = nil
			for _, id := range ch.Members {
				id = strings.ToLower(strings.TrimSpace(id))
				if !have[id] {
					add = append(add, id)
				}
			}
		}
		for _, id := range remove {
			id = strings.ToLower(strings.TrimSpace(id))
			if !authz.ValidUUID(id) {
				continue
			}
			linked, err := linkedHere(ctx, tx, scope.WorkspaceID, id)
			if err != nil {
				return err
			}
			if !linked {
				// Not linked here: invisible to this token, never removed.
				continue
			}
			if _, err := identity.RemoveGroupMemberTx(ctx, tx, scope.WorkspaceID, ga, groupID, id, now); err != nil {
				return mapGroupIdentityErr(err)
			}
		}
		if ch.DisplayName != nil {
			if _, err := identity.RenameGroupTx(ctx, tx, scope.WorkspaceID, ga, groupID, *ch.DisplayName); err != nil {
				return mapGroupIdentityErr(err)
			}
		}
		if err := addManagedMembers(ctx, tx, scope, ga, groupID, add); err != nil {
			return err
		}
		out, err = loadManagedGroup(ctx, tx, scope.WorkspaceID, groupID)
		return err
	})
	return out, err
}

// DeleteManagedGroup hard-deletes a managed group and its member rows
// through identity.DeleteGroupTx (the local delete path).
func (p *WorkspacePostgres) DeleteManagedGroup(ctx context.Context, scope TokenScope, groupID string, actor Actor, now time.Time) error {
	if !authz.ValidUUID(groupID) {
		return ErrNotFound
	}
	return p.scopedMembership(ctx, scope.WorkspaceID, func(tx pgx.Tx) error {
		return mapGroupIdentityErr(identity.DeleteGroupTx(ctx, tx, scope.WorkspaceID, groupActor(scope, actor), groupID, now))
	})
}

// addManagedMembers adds each id after checking it is linked to this
// workspace with a live link. identity.AddGroupMemberTx then requires an
// active account with a role binding here. Any failure is
// ErrMemberNotEligible and the caller's transaction rolls back.
func addManagedMembers(ctx context.Context, tx pgx.Tx, scope TokenScope, ga identity.GroupActor, groupID string, ids []string) error {
	seen := map[string]bool{}
	for _, id := range ids {
		id = strings.ToLower(strings.TrimSpace(id))
		if seen[id] {
			continue
		}
		seen[id] = true
		if !authz.ValidUUID(id) {
			return ErrMemberNotEligible
		}
		var live bool
		err := tx.QueryRow(ctx, `
			SELECT deactivated_at IS NULL FROM scim_workspace_users
			 WHERE workspace_id = $1::uuid AND user_id = $2::uuid`, scope.WorkspaceID, id).Scan(&live)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && !live) {
			return ErrMemberNotEligible
		}
		if err != nil {
			return mapWorkspaceErr(err)
		}
		if _, err := identity.AddGroupMemberTx(ctx, tx, scope.WorkspaceID, ga, groupID, id); err != nil {
			return mapGroupIdentityErr(err)
		}
	}
	return nil
}

func linkedHere(ctx context.Context, tx pgx.Tx, workspaceID, userID string) (bool, error) {
	var ok bool
	err := tx.QueryRow(ctx, `
		SELECT EXISTS (SELECT 1 FROM scim_workspace_users WHERE workspace_id = $1::uuid AND user_id = $2::uuid)`,
		workspaceID, userID).Scan(&ok)
	return ok, mapWorkspaceErr(err)
}

func loadManagedGroup(ctx context.Context, tx pgx.Tx, workspaceID, groupID string) (ManagedGroup, error) {
	var g ManagedGroup
	err := tx.QueryRow(ctx, `
		SELECT `+managedGroupColumns+`
		  FROM workspace_groups g
		 WHERE g.workspace_id = $1::uuid AND g.id = $2::uuid AND g.managed_by = 'scim'`,
		workspaceID, groupID).Scan(&g.ID, &g.DisplayName, &g.ExternalID, &g.CreatedAt, &g.UpdatedAt)
	if err != nil {
		return ManagedGroup{}, mapWorkspaceErr(err)
	}
	g.Members, err = linkedGroupMembers(ctx, tx, workspaceID, groupID)
	if err != nil {
		return ManagedGroup{}, err
	}
	return g, nil
}

// linkedGroupMembers lists member rows of a group whose user this
// workspace's IdP linked. A member added locally (for example while the
// instance was in workspaces mode) who is not linked stays invisible.
func linkedGroupMembers(ctx context.Context, tx pgx.Tx, workspaceID, groupID string) ([]GroupMember, error) {
	rows, err := tx.Query(ctx, `
		SELECT u.id::text, u.display_name
		  FROM workspace_group_members m
		  JOIN scim_workspace_users l ON l.workspace_id = m.workspace_id AND l.user_id = m.user_id
		  JOIN users u ON u.id = m.user_id
		 WHERE m.workspace_id = $1::uuid AND m.group_id = $2::uuid
		 ORDER BY lower(u.display_name), u.id`, workspaceID, groupID)
	if err != nil {
		return nil, mapWorkspaceErr(err)
	}
	defer rows.Close()
	out := []GroupMember{}
	for rows.Next() {
		var m GroupMember
		if err := rows.Scan(&m.UserID, &m.DisplayName); err != nil {
			return nil, mapWorkspaceErr(err)
		}
		out = append(out, m)
	}
	return out, mapWorkspaceErr(rows.Err())
}

// mapGroupIdentityErr maps identity group errors to SCIM errors.
func mapGroupIdentityErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, identity.ErrGroupNameTaken), errors.Is(err, identity.ErrGroupExternalIDTaken):
		return ErrUniqueness
	case errors.Is(err, identity.ErrGroupMemberNotInWorkspace):
		return ErrMemberNotEligible
	case errors.Is(err, identity.ErrGroupNameInvalid):
		return ErrInvalid
	case errors.Is(err, identity.ErrGroupManagedBySCIM):
		// A SCIM actor never gets this; fail closed if it ever does.
		return ErrNotFound
	}
	for _, known := range []error{ErrUniqueness, ErrMemberNotEligible} {
		if errors.Is(err, known) {
			return err
		}
	}
	return mapIdentityErr(err)
}
