package identity

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
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
// The lock is on the membership row only, never the users row. A users
// row lock would make SCIM and other user updates wait behind a decide.
// It is not needed: the request access check already fails a disabled
// user before this runs; the RemoveMember that SCIM runs after flipping
// the status waits on this member-row lock; and the users.status =
// 'active' join still excludes a last admin whose RemoveMember was
// refused and who kept their bindings.
//
// A machine principal (users.issuer = parkedapproval.MachineIssuer, bound
// as a parameter) is never an eligible member.
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
		  AND u.issuer <> $4
		  AND EXISTS (
		      SELECT 1 FROM workspace_role_bindings b
		      WHERE b.workspace_id = m.workspace_id AND b.user_id = m.user_id
		  )
		LIMIT 1
		FOR SHARE OF m
	`, workspaceID, userID, groups, parkedapproval.MachineIssuer)
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
