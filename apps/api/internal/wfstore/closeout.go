package wfstore

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// Skip reasons (#660). A step is skipped exactly when it carries one.
const (
	SkipBranchNotTaken        = "branch_not_taken"
	SkipUpstreamFailed        = "upstream_failed"
	SkipUpstreamIndeterminate = "upstream_indeterminate"
	SkipRunCanceled           = "run_canceled"
	SkipWorkflowDeleted       = "workflow_deleted"
)

// SkipReasons is the closed set exposed on the step API.
var SkipReasons = []string{SkipBranchNotTaken, SkipUpstreamFailed, SkipUpstreamIndeterminate, SkipRunCanceled, SkipWorkflowDeleted}

// ActionStepsClosed is the counts-only audit row written by a close-out.
const ActionStepsClosed = "execution.steps_closed"

// ActionStepsReopened is the counts-only audit row written when RetryStep
// reopens closed-out steps.
const ActionStepsReopened = "execution.steps_reopened"

// closeOutReason maps a terminal run status to the reason never-run steps
// get. "" means the status closes nothing (not terminal, or pinned).
func closeOutReason(status string) string {
	switch status {
	case ExecutionFailed:
		return SkipUpstreamFailed
	case ExecutionIndeterminate:
		return SkipUpstreamIndeterminate
	case ExecutionCanceled:
		return SkipRunCanceled
	case ExecutionSucceeded:
		// A succeeded rollup has no blocked work; anything left is an
		// untaken path.
		return SkipBranchNotTaken
	}
	return ""
}

// reopenable reports whether RetryStep may reopen a closed-out step.
// run_canceled, workflow_deleted and branch_not_taken never reopen
// (retries on canceled runs are refused anyway).
func reopenable(reason string) bool {
	switch reason {
	case SkipUpstreamFailed, SkipUpstreamIndeterminate:
		return true
	}
	return false
}

// closeOutTx is the single Postgres close-out (#660): every never-run step
// (pending or queued) of a run that is ending becomes skipped with reason,
// and its blocked/queued job becomes skipped. Running, claimed and waiting
// steps are left to their own job path. unresolved_incoming is untouched
// so a retry can reopen exactly. Runs in the caller's transaction.
func closeOutTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, executionID, reason string, now time.Time) error {
	if reason == "" {
		return nil
	}
	ws := scope.WorkspaceID()
	// Lock order matches every other writer: (execution, held by the
	// caller) -> jobs -> steps, each in id order.
	if _, err := lockIDsTx(ctx, tx, `
		SELECT j.id::text FROM execution_jobs j
		 WHERE j.workspace_id = $1::uuid AND j.execution_id = $2::uuid
		   AND j.status IN ('blocked', 'queued')
		   AND EXISTS (SELECT 1 FROM execution_steps s
		                WHERE s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
		                  AND s.status IN ('pending', 'queued'))
		 ORDER BY j.id FOR UPDATE OF j
	`, ws, executionID); err != nil {
		return err
	}
	ids, err := lockIDsTx(ctx, tx, `
		SELECT id::text FROM execution_steps
		 WHERE workspace_id = $1::uuid AND execution_id = $2::uuid
		   AND status IN ('pending', 'queued')
		 ORDER BY id FOR UPDATE
	`, ws, executionID)
	if err != nil || len(ids) == 0 {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		   SET status = 'skipped', updated_at = $1
		 WHERE workspace_id = $2::uuid AND execution_id = $3::uuid
		   AND execution_step_id = ANY($4::uuid[]) AND status IN ('blocked', 'queued')
	`, now, ws, executionID, ids); err != nil {
		return mapDBErr(err)
	}
	jobs, err := countJobsTx(ctx, tx, ws, executionID, ids, JobSkipped)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		   SET status = 'skipped', skip_reason = $4,
		       finished_at = COALESCE(finished_at, $1), updated_at = $1
		 WHERE workspace_id = $2::uuid AND execution_id = $3::uuid
		   AND id = ANY($5::uuid[])
	`, now, ws, executionID, reason, ids); err != nil {
		return mapDBErr(err)
	}
	_, err = insertAuditTx(ctx, tx, scope, closeOutAudit(executionID, reason, len(ids), jobs))
	return err
}

// lockIDsTx runs an ordered SELECT ... FOR UPDATE and returns the ids.
func lockIDsTx(ctx context.Context, tx pgx.Tx, sql string, args ...any) ([]string, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, mapDBErr(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return ids, nil
}

func countJobsTx(ctx context.Context, tx pgx.Tx, ws, executionID string, stepIDs []string, status string) (int, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM execution_jobs
		 WHERE workspace_id = $1::uuid AND execution_id = $2::uuid
		   AND execution_step_id = ANY($3::uuid[]) AND status = $4
	`, ws, executionID, stepIDs, status).Scan(&n)
	return n, mapDBErr(err)
}

func closeOutAudit(executionID, reason string, steps, jobs int) AuditWrite {
	return AuditWrite{
		Action:       ActionStepsClosed,
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      reason,
		Details:      map[string]any{"reason": reason, "steps": steps, "jobs": jobs},
	}
}

// reopenTx is RetryStep's inverse of closeOutTx: reopenable skipped steps
// go back to pending with their skipped jobs blocked, so normal edge
// release decides from there. A step that had no unresolved incoming edges
// when it was closed (it was queued) goes straight back to queued. Same
// lock order as closeOutTx: jobs, then steps, each in id order.
func reopenTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, executionID string, now time.Time) error {
	ws := scope.WorkspaceID()
	if _, err := lockIDsTx(ctx, tx, `
		SELECT j.id::text FROM execution_jobs j
		 WHERE j.workspace_id = $1::uuid AND j.execution_id = $2::uuid AND j.status = 'skipped'
		   AND EXISTS (SELECT 1 FROM execution_steps s
		                WHERE s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
		                  AND s.status = 'skipped'
		                  AND s.skip_reason IN ('upstream_failed', 'upstream_indeterminate'))
		 ORDER BY j.id FOR UPDATE OF j
	`, ws, executionID); err != nil {
		return err
	}
	ids, err := lockIDsTx(ctx, tx, `
		SELECT id::text FROM execution_steps
		 WHERE workspace_id = $1::uuid AND execution_id = $2::uuid AND status = 'skipped'
		   AND skip_reason IN ('upstream_failed', 'upstream_indeterminate')
		 ORDER BY id FOR UPDATE
	`, ws, executionID)
	if err != nil || len(ids) == 0 {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs j
		   SET status = CASE WHEN s.unresolved_incoming = 0 THEN 'queued' ELSE 'blocked' END, updated_at = $1
		  FROM execution_steps s
		 WHERE j.workspace_id = $2::uuid AND j.execution_id = $3::uuid
		   AND s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
		   AND j.execution_step_id = ANY($4::uuid[]) AND j.status = 'skipped'
	`, now, ws, executionID, ids); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		   SET status = CASE WHEN unresolved_incoming = 0 THEN 'queued' ELSE 'pending' END,
		       skip_reason = NULL, finished_at = NULL, updated_at = $1
		 WHERE workspace_id = $2::uuid AND execution_id = $3::uuid AND id = ANY($4::uuid[])
	`, now, ws, executionID, ids); err != nil {
		return mapDBErr(err)
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action: ActionStepsReopened, ResourceType: "execution", ResourceID: executionID,
		Outcome: "reopened", Details: map[string]any{"steps": len(ids)},
	})
	return err
}

// closeOutLocked is the Memory twin of closeOutTx. The caller holds m.mu.
func (m *Memory) closeOutLocked(scope isolation.Scope, exec *memExecution, reason string, now time.Time) {
	if reason == "" {
		return
	}
	steps, jobs := 0, 0
	for i := range exec.steps {
		switch exec.steps[i].Status {
		case ExecutionPending, ExecutionQueued:
		default:
			continue
		}
		applyStepStatus(&exec.steps[i], ExecutionSkipped, now)
		exec.steps[i].SkipReason = reason
		steps++
		for j := range exec.jobs {
			if exec.jobs[j].ExecutionStepID == exec.steps[i].ID && (exec.jobs[j].Status == JobBlocked || exec.jobs[j].Status == JobQueued) {
				exec.jobs[j].Status = JobSkipped
				exec.jobs[j].UpdatedAt = now
				jobs++
			}
		}
	}
	if steps > 0 {
		m.appendAuditLocked(scope, closeOutAudit(exec.record.ID, reason, steps, jobs), now)
	}
}

// reopenLocked is the Memory twin of reopenTx.
func (m *Memory) reopenLocked(scope isolation.Scope, exec *memExecution, now time.Time) {
	n := 0
	for i := range exec.steps {
		if exec.steps[i].Status != ExecutionSkipped || !reopenable(exec.steps[i].SkipReason) {
			continue
		}
		exec.steps[i].Status = ExecutionPending
		jobStatus := JobBlocked
		if exec.steps[i].UnresolvedIncoming == 0 {
			exec.steps[i].Status = ExecutionQueued
			jobStatus = JobQueued
		}
		exec.steps[i].SkipReason = ""
		exec.steps[i].FinishedAt = nil
		exec.steps[i].UpdatedAt = now
		n++
		for j := range exec.jobs {
			if exec.jobs[j].ExecutionStepID == exec.steps[i].ID && exec.jobs[j].Status == JobSkipped {
				exec.jobs[j].Status = jobStatus
				exec.jobs[j].UpdatedAt = now
			}
		}
	}
	if n > 0 {
		m.appendAuditLocked(scope, AuditWrite{
			Action: ActionStepsReopened, ResourceType: "execution", ResourceID: exec.record.ID,
			Outcome: "reopened", Details: map[string]any{"steps": n},
		}, now)
	}
}
