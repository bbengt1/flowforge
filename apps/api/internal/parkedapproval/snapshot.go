package parkedapproval

import (
	"context"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
)

// Snapshot is the park-time approver set for a targeted gate.
// Users are the named users who are eligible now. Groups are the named
// group ids that exist in the workspace; their members are never copied.
// HasDecider is false only when nobody but the requester could ever
// decide: no eligible named user, no eligible live group member, and no
// active admin other than the requester.
type Snapshot struct {
	Users      []string
	Groups     []string
	HasDecider bool
	// Targeted is true when at least one named user or live group member
	// is eligible. False with HasDecider true means only an admin
	// override can decide.
	Targeted bool
}

// Eligible reports the decider rule shared by park, resync, and decide:
// active, roles grant approval.decide, roles meet the gate role (exact
// role or admin), and not the requester.
func Eligible(userID, status, requester, role string, roleKeys []string) bool {
	if status != "active" || len(roleKeys) == 0 {
		return false
	}
	if requester != "" && strings.EqualFold(userID, requester) {
		return false
	}
	if !authz.Allows(authz.ExpandWorkspaceRoles(roleKeys), authz.PermApprovalDecide) {
		return false
	}
	required := strings.TrimSpace(role)
	if required == "" {
		required = "approver"
	}
	for _, k := range roleKeys {
		if k == "admin" || k == required {
			return true
		}
	}
	return false
}

// ResolveSnapshot reads the eligible approvers inside the caller's
// workspace-scoped transaction. Plain reads only: it takes no row locks,
// so it cannot join a lock cycle with RemoveMember or group edits.
func ResolveSnapshot(ctx context.Context, tx pgx.Tx, workspaceID, requester, role string, users, groups []string) (Snapshot, error) {
	users = validIDs(users)
	groups = validIDs(groups)
	requester = strings.ToLower(strings.TrimSpace(requester))
	snap := Snapshot{Users: []string{}, Groups: []string{}}

	if len(groups) > 0 {
		rows, err := tx.Query(ctx, `
			SELECT id::text FROM workspace_groups
			 WHERE workspace_id = $1::uuid AND id = ANY($2::uuid[])
			 ORDER BY id
		`, workspaceID, groups)
		if err != nil {
			return Snapshot{}, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return Snapshot{}, err
			}
			snap.Groups = append(snap.Groups, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return Snapshot{}, err
		}
	}

	var cands []Candidate
	rows, err := tx.Query(ctx, `
		WITH cand AS (
		    SELECT unnest($2::uuid[]) AS user_id, true AS named
		    UNION ALL
		    SELECT m.user_id, false
		      FROM workspace_group_members m
		     WHERE m.workspace_id = $1::uuid AND m.group_id = ANY($3::uuid[])
		)
		SELECT c.user_id::text, bool_or(c.named), u.status,
		       COALESCE(array_agg(DISTINCT r.key) FILTER (WHERE r.key IS NOT NULL), '{}')
		  FROM cand c
		  JOIN users u ON u.id = c.user_id
		  LEFT JOIN workspace_role_bindings b ON b.workspace_id = $1::uuid AND b.user_id = c.user_id
		  LEFT JOIN roles r ON r.id = b.role_id
		 GROUP BY c.user_id, u.status
		 ORDER BY c.user_id
	`, workspaceID, users, snap.Groups)
	if err != nil {
		return Snapshot{}, err
	}
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.ID, &c.Named, &c.Status, &c.Roles); err != nil {
			rows.Close()
			return Snapshot{}, err
		}
		cands = append(cands, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Snapshot{}, err
	}
	return BuildSnapshot(requester, role, snap.Groups, cands, func() (bool, error) {
		return OtherActiveAdmin(ctx, tx, workspaceID, requester)
	})
}

// Candidate is one possible decider for a targeted gate: a named user
// (Named) or a live member of a named group, with the user's status and
// role keys in the gate's workspace.
type Candidate struct {
	ID     string
	Named  bool
	Status string
	Roles  []string
}

// BuildSnapshot applies the item-6 rule to candidates. Postgres
// (ResolveSnapshot) and the in-memory identity store both call it, so the
// two stores share one eligibility rule. groups are the named groups that
// exist in the workspace. otherAdmin is called only when no candidate is
// eligible; it reports an active admin other than the requester.
func BuildSnapshot(requester, role string, groups []string, cands []Candidate, otherAdmin func() (bool, error)) (Snapshot, error) {
	requester = strings.ToLower(strings.TrimSpace(requester))
	snap := Snapshot{Users: []string{}, Groups: append([]string{}, groups...)}
	for _, c := range cands {
		if !Eligible(c.ID, c.Status, requester, role, c.Roles) {
			continue
		}
		snap.Targeted = true
		if c.Named {
			snap.Users = append(snap.Users, c.ID)
		}
	}
	if snap.Targeted {
		snap.HasDecider = true
		return snap, nil
	}
	if otherAdmin == nil {
		return snap, nil
	}
	admin, err := otherAdmin()
	if err != nil {
		return Snapshot{}, err
	}
	snap.HasDecider = admin
	return snap, nil
}

// OtherActiveAdmin reports whether the workspace has an active admin who
// is not the requester. That admin could decide by override.
func OtherActiveAdmin(ctx context.Context, tx pgx.Tx, workspaceID, requester string) (bool, error) {
	ids, err := ActiveAdmins(ctx, tx, workspaceID, requester, 1)
	return len(ids) > 0, err
}

// ActiveAdmins returns up to limit (at least 1) distinct active admins of
// the workspace, sorted by id, leaving out exclude (empty: nobody). It is
// the one definition of an enabled admin: a live binding to the admin
// role (the only role holding workspace.administer) and users.status
// 'active'. The override fallback (OtherActiveAdmin), the bounded
// re-check on admin loss and the last-admin guard in identity all use it.
func ActiveAdmins(ctx context.Context, tx pgx.Tx, workspaceID, exclude string, limit int) ([]string, error) {
	if limit < 1 {
		limit = 1
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT b.user_id::text
		  FROM workspace_role_bindings b
		  JOIN roles r ON r.id = b.role_id
		  JOIN users u ON u.id = b.user_id
		 WHERE b.workspace_id = $1::uuid
		   AND r.key = 'admin'
		   AND u.status = 'active'
		   AND b.user_id IS DISTINCT FROM $2::uuid
		 ORDER BY 1
		 LIMIT $3
	`, workspaceID, nullUUID(exclude), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// WriteSnapshot replaces the approver rows for one approval.
func WriteSnapshot(ctx context.Context, tx pgx.Tx, workspaceID, approvalID string, snap Snapshot) error {
	if _, err := tx.Exec(ctx, `DELETE FROM approval_approver_users WHERE workspace_id = $1::uuid AND approval_id = $2::uuid`, workspaceID, approvalID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM approval_approver_groups WHERE workspace_id = $1::uuid AND approval_id = $2::uuid`, workspaceID, approvalID); err != nil {
		return err
	}
	if len(snap.Users) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO approval_approver_users (workspace_id, approval_id, user_id)
			SELECT $1::uuid, $2::uuid, unnest($3::uuid[])
		`, workspaceID, approvalID, snap.Users); err != nil {
			return err
		}
	}
	if len(snap.Groups) > 0 {
		if _, err := tx.Exec(ctx, `
			INSERT INTO approval_approver_groups (workspace_id, approval_id, group_id)
			SELECT $1::uuid, $2::uuid, unnest($3::uuid[])
		`, workspaceID, approvalID, snap.Groups); err != nil {
			return err
		}
	}
	return nil
}

func validIDs(ids []string) []string {
	out := []string{}
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
