// Package approvalgate re-checks waiting targeted approval gates when a
// group or a person they target loses members. It is the one path used
// by local group delete and member removal, by SCIM group delete and
// member removal, and by every workspace membership loss (admin removal,
// SCIM active:false, SCIM DELETE), so SCIM has no gate logic of its own.
//
// Lock order: executions, then approvals (both by id), the same order as
// boot resync and Decide. A caller takes these locks with Lock before it
// deletes any role binding or group row, and runs Recheck after the
// deletes in the same transaction.
//
// Failing the waiting gate step is wfstore's job. wfstore imports this
// package and registers wfstore.SettleNoEligibleDeciderGate at init, so
// identity (which wfstore's tests import) never imports wfstore. If no
// settler is registered, Recheck refuses to close a gate and the
// caller's transaction rolls back: it never cancels an approval while
// leaving its step waiting.
package approvalgate

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/jackc/pgx/v5"
)

// Settler fails a waiting flow.approval step (and its job) with
// requirement_unresolvable / no_eligible_decider in tx, and rolls the
// run up the same way as a park-time no-eligible-decider failure.
// The workspace is the transaction's scoped workspace.
type Settler func(ctx context.Context, tx pgx.Tx, workspaceID, workflowID, executionID, nodeID string, now time.Time) error

var settler Settler

// RegisterSettler installs the step settler. wfstore calls it at init.
func RegisterSettler(fn Settler) { settler = fn }

// ErrNoSettler means a gate had to be closed but no settler is
// registered. The caller's transaction must roll back.
var ErrNoSettler = errors.New("approvalgate: no gate settler registered")

// Gate is one pending targeted approval locked by Lock.
type Gate struct {
	ID          string
	WorkflowID  string
	ExecutionID string
	NodeID      string
	RequestedBy string
	Role        string
}

// Lock finds and locks every pending targeted approval in the
// transaction's workspace whose stored approver snapshot names one of
// groupIDs, names one of userIDs directly, or names a group one of
// userIDs is a member of right now. It locks the executions first and
// then the approval rows, each in id order. Untargeted gates are never
// returned. Malformed ids are dropped, so they match nothing.
func Lock(ctx context.Context, tx pgx.Tx, workspaceID string, groupIDs, userIDs []string) ([]Gate, error) {
	groupIDs = validIDs(groupIDs)
	userIDs = validIDs(userIDs)
	if !authz.ValidUUID(workspaceID) || (len(groupIDs) == 0 && len(userIDs) == 0) {
		return nil, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT a.id::text, COALESCE(a.execution_id::text, '')
		  FROM approvals a
		 WHERE a.workspace_id = $1::uuid
		   AND a.status = 'pending'
		   AND a.approvers_digest <> ''
		   AND (
		        EXISTS (
		            SELECT 1 FROM approval_approver_groups g
		             WHERE g.workspace_id = a.workspace_id AND g.approval_id = a.id
		               AND (g.group_id = ANY($2::uuid[])
		                    OR g.group_id IN (SELECT m.group_id FROM workspace_group_members m
		                                       WHERE m.workspace_id = $1::uuid AND m.user_id = ANY($3::uuid[])))
		        )
		        OR EXISTS (
		            SELECT 1 FROM approval_approver_users u
		             WHERE u.workspace_id = a.workspace_id AND u.approval_id = a.id
		               AND u.user_id = ANY($3::uuid[])
		        )
		   )
		 ORDER BY a.id
	`, workspaceID, groupIDs, userIDs)
	if err != nil {
		return nil, err
	}
	var ids []string
	execSet := map[string]bool{}
	for rows.Next() {
		var id, exec string
		if err := rows.Scan(&id, &exec); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
		if exec != "" {
			execSet[exec] = true
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(ids) == 0 {
		return nil, nil
	}
	execs := make([]string, 0, len(execSet))
	for id := range execSet {
		execs = append(execs, id)
	}
	sort.Strings(execs)
	for _, id := range execs {
		if _, err := tx.Exec(ctx, `SELECT id FROM executions WHERE id = $1::uuid FOR UPDATE`, id); err != nil {
			return nil, err
		}
	}
	var out []Gate
	for _, id := range ids {
		var g Gate
		err := tx.QueryRow(ctx, `
			SELECT id::text, workflow_id::text, COALESCE(execution_id::text, ''), node_id,
			       COALESCE(requested_by::text, ''), approver_role
			  FROM approvals
			 WHERE id = $1::uuid AND status = 'pending'
			   FOR UPDATE
		`, id).Scan(&g.ID, &g.WorkflowID, &g.ExecutionID, &g.NodeID, &g.RequestedBy, &g.Role)
		if errors.Is(err, pgx.ErrNoRows) {
			// Closed by someone else while this transaction waited.
			continue
		}
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, nil
}

// Recheck applies the park-time decider rule to each gate from Lock,
// after the caller's deletes, using the gate's stored approver snapshot.
// A gate that still has an eligible decider (a named user, a live group
// member, or another active admin) keeps waiting and is not rewritten.
// A gate with none is closed exactly as a no-eligible-decider resync
// close: the approval is canceled with reason requirement_unresolvable
// and cause no_eligible_decider, and the waiting gate step fails with the
// same reason. It returns how many gates were closed.
func Recheck(ctx context.Context, tx pgx.Tx, workspaceID string, gates []Gate, now time.Time) (int, error) {
	if len(gates) == 0 {
		return 0, nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	closed := 0
	for _, g := range gates {
		users, err := snapshotIDs(ctx, tx, `SELECT user_id::text FROM approval_approver_users WHERE workspace_id = $1::uuid AND approval_id = $2::uuid ORDER BY user_id`, workspaceID, g.ID)
		if err != nil {
			return closed, err
		}
		groups, err := snapshotIDs(ctx, tx, `SELECT group_id::text FROM approval_approver_groups WHERE workspace_id = $1::uuid AND approval_id = $2::uuid ORDER BY group_id`, workspaceID, g.ID)
		if err != nil {
			return closed, err
		}
		snap, err := parkedapproval.ResolveSnapshot(ctx, tx, workspaceID, g.RequestedBy, g.Role, users, groups)
		if err != nil {
			return closed, err
		}
		if snap.HasDecider {
			continue
		}
		if settler == nil {
			return closed, ErrNoSettler
		}
		tag, err := tx.Exec(ctx, `
			WITH c AS (
				UPDATE approvals
				   SET status = 'canceled',
				       close_reason = 'requirement_unresolvable',
				       decided_by = NULL,
				       decided_at = NULL,
				       updated_at = $2
				 WHERE id = $1::uuid AND status = 'pending'
				RETURNING workspace_id, id
			)
			INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
			SELECT workspace_id, id, 'canceled', NULL,
			       jsonb_build_object('reason', 'requirement_unresolvable', 'cause', $3::text), $2
			  FROM c
		`, g.ID, now, parkedapproval.CauseNoEligibleDecider)
		if err != nil {
			return closed, err
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		if err := settler(ctx, tx, workspaceID, g.WorkflowID, g.ExecutionID, g.NodeID, now); err != nil {
			return closed, err
		}
		closed++
	}
	return closed, nil
}

func snapshotIDs(ctx context.Context, tx pgx.Tx, sql, workspaceID, approvalID string) ([]string, error) {
	rows, err := tx.Query(ctx, sql, workspaceID, approvalID)
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
