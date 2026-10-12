package wfstore

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// ReasonRunEnded (#668) is the approval close reason and the step error
// code when a run reaches a terminal status (other than cancel or workflow
// delete, which keep their own reasons) while a flow.approval gate is
// still waiting. The gate step ends failed; it is never routed through
// onError and writes no step.error_routed.
const ReasonRunEnded = "run_ended"

// ActionGatesEnded is the counts-only audit row for gates closed by a
// run ending.
const ActionGatesEnded = "execution.gates_ended"

func runEndedStepError() map[string]any {
	return map[string]any{
		"code":    ReasonRunEnded,
		"message": "The run ended before this approval was decided.",
	}
}

// endsGates reports whether a terminal status closes waiting approval
// gates with run_ended. Cancel and workflow delete close them on their
// own paths with run_canceled / workflow_deleted.
func endsGates(status string) bool {
	return isTerminalExecution(status) && status != ExecutionPinned && status != ExecutionCanceled
}

// lockRunEndTx takes the #668 close-out locks in the documented order
// before anything is written: (execution, held by the caller) -> jobs ->
// steps -> approvals, each ORDER BY id FOR UPDATE. It covers the
// never-run rows closeOutTx touches and the waiting flow.approval gates,
// so the later row locks in closeOutTx are re-locks of held rows.
func lockRunEndTx(ctx context.Context, tx pgx.Tx, ws, executionID string) error {
	if _, err := lockIDsTx(ctx, tx, `
		SELECT j.id::text FROM execution_jobs j
		  JOIN execution_steps s ON s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
		 WHERE j.workspace_id = $1::uuid AND j.execution_id = $2::uuid
		   AND ((j.status IN ('blocked', 'queued') AND s.status IN ('pending', 'queued'))
		     OR (j.status = 'waiting' AND s.status = 'waiting' AND s.node_type = 'flow.approval'))
		 ORDER BY j.id FOR UPDATE OF j
	`, ws, executionID); err != nil {
		return err
	}
	if _, err := lockIDsTx(ctx, tx, `
		SELECT id::text FROM execution_steps
		 WHERE workspace_id = $1::uuid AND execution_id = $2::uuid
		   AND (status IN ('pending', 'queued') OR (status = 'waiting' AND node_type = 'flow.approval'))
		 ORDER BY id FOR UPDATE
	`, ws, executionID); err != nil {
		return err
	}
	_, err := lockIDsTx(ctx, tx, `
		SELECT id::text FROM approvals
		 WHERE workspace_id = $1::uuid AND execution_id = $2::uuid AND status = 'pending'
		 ORDER BY id FOR UPDATE
	`, ws, executionID)
	return err
}

// endWaitingGatesTx fails every waiting flow.approval gate with run_ended
// and closes the run's pending approvals with run_ended, in the caller's
// close-out transaction. Rows are already locked by lockRunEndTx.
func endWaitingGatesTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, executionID string, now time.Time) error {
	ws := scope.WorkspaceID()
	errRaw, err := marshalObject(runEndedStepError())
	if err != nil {
		return ErrInvalid
	}
	ids, err := lockIDsTx(ctx, tx, `
		UPDATE execution_steps
		   SET status = 'failed', error_redacted = $4::jsonb,
		       finished_at = COALESCE(finished_at, $1), updated_at = $1
		 WHERE workspace_id = $2::uuid AND execution_id = $3::uuid
		   AND status = 'waiting' AND node_type = 'flow.approval'
		RETURNING id::text
	`, now, ws, executionID, errRaw)
	if err != nil {
		return err
	}
	if len(ids) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE execution_jobs
			   SET status = 'failed', worker_id = NULL, lease_expires_at = NULL, updated_at = $1
			 WHERE workspace_id = $2::uuid AND execution_id = $3::uuid
			   AND execution_step_id = ANY($4::uuid[]) AND status = 'waiting'
		`, now, ws, executionID, ids); err != nil {
			return mapDBErr(err)
		}
	}
	closed, err := closePendingApprovalsTx(ctx, tx, executionID, ReasonRunEnded, now)
	if err != nil {
		return err
	}
	if len(ids) == 0 && closed == 0 {
		return nil
	}
	_, err = insertAuditTx(ctx, tx, scope, gatesEndedAudit(executionID, len(ids), closed))
	return err
}

func gatesEndedAudit(executionID string, gates, approvals int) AuditWrite {
	return AuditWrite{
		Action:       ActionGatesEnded,
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonRunEnded,
		Details:      map[string]any{"reason": ReasonRunEnded, "gates": gates, "approvalsClosed": approvals},
	}
}

// endWaitingGatesLocked is the Memory twin. Memory approvals live in a
// separate store; it closes pending rows of runs that ended with
// run_ended when it next reads them (see approval.Memory.SetRunEnded),
// so this only fails the gate steps and jobs. The caller holds m.mu.
func (m *Memory) endWaitingGatesLocked(scope isolation.Scope, exec *memExecution, now time.Time) {
	gates := 0
	for i := range exec.steps {
		st := &exec.steps[i]
		if st.Status != ExecutionWaiting || st.NodeType != "flow.approval" {
			continue
		}
		st.Error = runEndedStepError()
		st.LeaseID = ""
		applyStepStatus(st, ExecutionFailed, now)
		gates++
		for j := range exec.jobs {
			job := &exec.jobs[j]
			if job.ExecutionStepID == st.ID && job.Status == JobWaiting {
				job.Status = JobFailed
				job.WorkerID = ""
				job.LeaseExpiresAt = nil
				job.UpdatedAt = now
			}
		}
	}
	if gates > 0 {
		m.appendAuditLocked(scope, gatesEndedAudit(exec.record.ID, gates, 0), now)
	}
}

// RunEndedForApprovals reports whether a run ended while the node's
// flow.approval gate was waiting, so its pending approval closes with
// run_ended. A gate that finished on its own (expired) does not count. Memory's approval store calls it
// with its own lock held (approval -> workflow lock order, same as
// ApprovalGateWaiting); it never calls back into the approval store.
func (m *Memory) RunEndedForApprovals(executionID, nodeID string) bool {
	if m == nil {
		return false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok {
		return false
	}
	if wf, ok := m.workflows[exec.record.WorkflowID]; ok && wf.deletedAt != nil {
		return false
	}
	if !endsGates(exec.record.Status) {
		return false
	}
	for _, st := range exec.steps {
		if st.NodeID != nodeID || st.NodeType != "flow.approval" {
			continue
		}
		if code, _ := st.Error["code"].(string); st.Status == ExecutionWaiting || code == ReasonRunEnded {
			return true
		}
	}
	return false
}
