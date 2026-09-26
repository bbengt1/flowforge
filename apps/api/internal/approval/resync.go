package approval

import (
	"context"
	"errors"
	"log/slog"
	"sort"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5"
)

// resyncLockClass is the transaction advisory lock class for boot resync.
// It does not overlap the migration lock or the scheduler leader lock.
const resyncLockClass int32 = 881726403

// resyncBudget caps boot resync so a stuck lock cannot hold startup open.
// Decide remains the backstop for anything this pass does not finish.
const resyncBudget = 2 * time.Minute

// ResyncStats counts one boot pass. A second pass on corrected rows is a no-op.
type ResyncStats struct {
	Workspaces int
	Corrected  int
	Closed     int
	Skipped    int
	Failed     int
}

// ResyncOpenApprovals walks every pending approval, one transaction per
// workspace, as the caller (the app pool is flowforge_app, NOBYPASSRLS).
// It rebuilds each requirement with ResolveGateRequirement. A difference
// is corrected. A rebuild failure cancels the row with
// requirement_unresolvable and, when that leaves a waiting gate, fails the
// gate step and its job with that reason. The run then follows the normal
// failed-step roll-up: a sibling that is already queued, claimed, or
// running finishes, and the run settles failed with
// requirement_unresolvable. A missing workflow fails the run with
// workflow_deleted. Outgoing edges, including expired, are not taken.
// requirement_unresolvable means the version lookup, the policy
// evaluation, or the matching requirement is missing.
// Errors are logged. The function returns after the budget or the walk.
func ResyncOpenApprovals(ctx context.Context, db DB, versions VersionSource, ops PinSource, log *slog.Logger) ResyncStats {
	if log == nil {
		log = slog.Default()
	}
	if db == nil || versions == nil {
		log.Error("approval resync skipped", "reason", "store unavailable")
		return ResyncStats{}
	}
	ctx, cancel := context.WithTimeout(ctx, resyncBudget)
	defer cancel()
	rows, err := db.Query(ctx, `SELECT id::text FROM workspaces ORDER BY id`)
	if err != nil {
		log.Error("approval resync skipped", "reason", "workspace list failed")
		return ResyncStats{}
	}
	defer rows.Close()
	var workspaces []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			log.Error("approval resync skipped", "reason", "workspace list failed")
			return ResyncStats{}
		}
		workspaces = append(workspaces, id)
	}
	if err := rows.Err(); err != nil {
		log.Error("approval resync skipped", "reason", "workspace list failed")
		return ResyncStats{}
	}
	var stats ResyncStats
	now := time.Now().UTC()
	for _, workspaceID := range workspaces {
		if ctx.Err() != nil {
			log.Error("approval resync stopped", "reason", "budget")
			break
		}
		one, err := resyncWorkspace(ctx, db, versions, ops, workspaceID, now)
		stats.Workspaces++
		stats.Corrected += one.Corrected
		stats.Closed += one.Closed
		stats.Skipped += one.Skipped
		stats.Failed += one.Failed
		if err != nil {
			stats.Failed++
			log.Error("approval resync workspace failed", "workspace", workspaceID, "reason", "transaction failed")
		}
	}
	log.Info("approval resync finished",
		"workspaces", stats.Workspaces,
		"corrected", stats.Corrected,
		"closed", stats.Closed,
		"skipped", stats.Skipped,
		"failed", stats.Failed,
	)
	return stats
}

type pendingRef struct {
	id         string
	workflowID string
	execution  string
}

func resyncWorkspace(ctx context.Context, db DB, versions VersionSource, ops PinSource, workspaceID string, now time.Time) (ResyncStats, error) {
	var stats ResyncStats
	scope, err := isolation.Authorize(workspaceID, "")
	if err != nil {
		return stats, err
	}
	tx, err := postgres.BeginScoped(ctx, db, workspaceID)
	if err != nil {
		return stats, err
	}
	defer tx.Rollback(ctx)
	var held bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1, hashtext($2))`, resyncLockClass, workspaceID).Scan(&held); err != nil {
		return stats, err
	}
	if !held {
		return stats, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT id::text, workflow_id::text, COALESCE(execution_id::text, '')
		  FROM approvals
		 WHERE status = 'pending'
		 ORDER BY id
	`)
	if err != nil {
		return stats, err
	}
	var pending []pendingRef
	for rows.Next() {
		var row pendingRef
		if err := rows.Scan(&row.id, &row.workflowID, &row.execution); err != nil {
			rows.Close()
			return stats, err
		}
		pending = append(pending, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return stats, err
	}
	rows.Close()
	if len(pending) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return stats, err
		}
		return stats, nil
	}
	if err := lockResyncParents(ctx, tx, pending); err != nil {
		return stats, err
	}
	sort.Slice(pending, func(i, j int) bool { return pending[i].id < pending[j].id })
	for _, row := range pending {
		if _, err := tx.Exec(ctx, `SELECT id FROM approvals WHERE id = $1::uuid FOR UPDATE`, row.id); err != nil {
			return stats, err
		}
	}
	for _, row := range pending {
		corrected, closed, failed := resyncOne(ctx, tx, scope, versions, ops, row.id, now)
		stats.Corrected += corrected
		stats.Closed += closed
		stats.Skipped += 1 - corrected - closed - failed
		stats.Failed += failed
	}
	if err := tx.Commit(ctx); err != nil {
		return stats, err
	}
	return stats, nil
}

func lockResyncParents(ctx context.Context, tx pgx.Tx, pending []pendingRef) error {
	workflows := map[string]struct{}{}
	executions := map[string]struct{}{}
	for _, row := range pending {
		if authz.ValidUUID(row.workflowID) {
			workflows[row.workflowID] = struct{}{}
		}
		if authz.ValidUUID(row.execution) {
			executions[row.execution] = struct{}{}
		}
	}
	wfOrder := make([]string, 0, len(workflows))
	for id := range workflows {
		wfOrder = append(wfOrder, id)
	}
	sort.Strings(wfOrder)
	for _, id := range wfOrder {
		var found string
		err := tx.QueryRow(ctx, `
			SELECT id::text FROM workflows
			 WHERE id = $1::uuid AND deleted_at IS NULL
			 FOR UPDATE
		`, id).Scan(&found)
		if err != nil && !errors.Is(mapDBErr(err), ErrNotFound) {
			return err
		}
	}
	execOrder := make([]string, 0, len(executions))
	for id := range executions {
		execOrder = append(execOrder, id)
	}
	sort.Strings(execOrder)
	for _, id := range execOrder {
		if _, err := tx.Exec(ctx, `SELECT id FROM executions WHERE id = $1::uuid FOR UPDATE`, id); err != nil {
			return err
		}
	}
	return nil
}

func resyncOne(ctx context.Context, tx pgx.Tx, scope isolation.Scope, versions VersionSource, ops PinSource, id string, now time.Time) (corrected, closed, failed int) {
	if _, err := tx.Exec(ctx, `SAVEPOINT approval_resync`); err != nil {
		return 0, 0, 1
	}
	rollback := true
	defer func() {
		if rollback {
			_, _ = tx.Exec(ctx, `ROLLBACK TO SAVEPOINT approval_resync`)
		}
	}()
	var rec Record
	if err := scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM approvals WHERE id = $1::uuid`, id), &rec); err != nil {
		return 0, 0, 1
	}
	if rec.Status != StatusPending {
		rollback = false
		_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT approval_resync`)
		return 0, 0, 0
	}
	req, err := ResolveGateRequirement(ctx, scope, versions, ops, rec.WorkflowID, rec.WorkflowVersionID, rec.NodeID, now)
	if err != nil {
		if err := cancelUnresolvable(ctx, tx, scope, rec, now); err != nil {
			return 0, 0, 1
		}
		if err := wfstore.SettleUnresolvableGate(ctx, tx, scope, rec.WorkflowID, rec.ExecutionID, rec.NodeID, now); err != nil {
			return 0, 0, 1
		}
		rollback = false
		_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT approval_resync`)
		return 0, 1, 0
	}
	next, changed := ProjectRequirement(rec, scope.WorkspaceID(), req)
	if !changed {
		rollback = false
		_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT approval_resync`)
		return 0, 0, 0
	}
	if _, err := updateBinding(ctx, tx, next, now); err != nil {
		return 0, 0, 1
	}
	rollback = false
	_, _ = tx.Exec(ctx, `RELEASE SAVEPOINT approval_resync`)
	return 1, 0, 0
}

func cancelUnresolvable(ctx context.Context, tx pgx.Tx, scope isolation.Scope, rec Record, now time.Time) error {
	var out Record
	if err := scanRecord(tx.QueryRow(ctx, `
		UPDATE approvals
		   SET status = 'canceled',
		       close_reason = $2,
		       decided_by = NULL,
		       decided_at = NULL,
		       updated_at = $3
		 WHERE id = $1::uuid AND status = 'pending'
		RETURNING `+recordColumns, rec.ID, ReasonRequirementUnresolvable, now), &out); err != nil {
		return err
	}
	return insertEvent(ctx, tx, scope, out.ID, EventCanceled, "", map[string]any{"reason": ReasonRequirementUnresolvable})
}
