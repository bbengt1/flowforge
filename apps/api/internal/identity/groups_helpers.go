package identity

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
)

// Querier is the read surface of the caller's transaction. pgx.Tx
// satisfies it. The transaction must already be scoped to workspaceID
// (postgres.BeginScoped). FORCE RLS hides group rows from any other
// scope, so a wrong or missing scope matches nobody.
type Querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// InTargetGroups reports whether userID is an eligible member of any of
// groupIDs in workspaceID. Eligible means a membership row exists, the
// user is active, and the user holds a live role binding in the
// workspace. It runs inside the caller's transaction and takes FOR SHARE
// on the matched membership row, so a concurrent member removal (group
// remove or workspace RemoveMember) waits for the caller to commit. The
// answer is cleanly before or after that removal, never in between.
//
// Membership never grants approval.decide. The caller still checks the
// user's own permission. At the approval decide call site:
//   - a non-nil error (database, network, timeout) should map to
//     approval.ErrBindingTransient: 503 approval_requirement_unavailable with
//     Retry-After 5, nothing recorded;
//   - false should map to 403 approver_not_targeted.
//
// Malformed ids, an empty group list, and deleted groups match nobody.
func InTargetGroups(ctx context.Context, q Querier, workspaceID, userID string, groupIDs []string) (bool, error) {
	groups := validGroupIDs(groupIDs)
	if len(groups) == 0 || !authz.ValidUUID(workspaceID) || !authz.ValidUUID(userID) {
		return false, nil
	}
	rows, err := q.Query(ctx, `
		SELECT m.group_id
		FROM workspace_group_members m
		JOIN users u ON u.id = m.user_id
		WHERE m.workspace_id = $1::uuid
		  AND m.user_id = $2::uuid
		  AND m.group_id = ANY($3::uuid[])
		  AND u.status = 'active'
		  AND EXISTS (
		      SELECT 1 FROM workspace_role_bindings b
		      WHERE b.workspace_id = m.workspace_id AND b.user_id = m.user_id
		  )
		LIMIT 1
		FOR SHARE OF m
	`, workspaceID, userID, groups)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	found := rows.Next()
	rows.Close()
	if err := rows.Err(); err != nil {
		return false, err
	}
	return found, nil
}

// ResolveTargetUsers returns a sorted snapshot of eligible user ids for a
// park-time check: members of groupIDs plus the direct userIDs, keeping
// only users who are active and hold a live role binding in workspaceID.
// It does not lock and does not write approval rows. Malformed ids and
// deleted groups contribute nobody. Run it inside the caller's
// workspace-scoped transaction.
func ResolveTargetUsers(ctx context.Context, q Querier, workspaceID string, groupIDs, userIDs []string) ([]string, error) {
	out := []string{}
	if !authz.ValidUUID(workspaceID) {
		return out, nil
	}
	groups := validGroupIDs(groupIDs)
	users := validGroupIDs(userIDs)
	if len(groups) == 0 && len(users) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, `
		SELECT u.id::text
		FROM users u
		WHERE u.status = 'active'
		  AND EXISTS (
		      SELECT 1 FROM workspace_role_bindings b
		      WHERE b.workspace_id = $1::uuid AND b.user_id = u.id
		  )
		  AND (
		      u.id = ANY($3::uuid[])
		      OR EXISTS (
		          SELECT 1 FROM workspace_group_members m
		          WHERE m.workspace_id = $1::uuid
		            AND m.user_id = u.id
		            AND m.group_id = ANY($2::uuid[])
		      )
		  )
		ORDER BY u.id
	`, workspaceID, groups, users)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
