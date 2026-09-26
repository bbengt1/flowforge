package wfstore

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/jackc/pgx/v5"
)

// SettleUnresolvableGate records a failed gate after an approval was
// closed because its requirement could not be rebuilt. The caller already
// holds the workflow lock (when the workflow still exists) and the
// execution lock, and takes those before approvals. A missing or deleted
// workflow follows the closed-approval path and fails the run with
// workflow_deleted. A live waiting gate fails closed the way any other
// step failure does: the gate step and job fail with
// requirement_unresolvable, and the run follows rollupExecutionTx in this
// same transaction. A sibling job that is already queued, claimed, or
// running is left to finish; the roll-up then settles the run failed.
// Outgoing edges are not resolved, so a step wired to expired does not
// run. A gate that is not waiting is left alone. This does not rewrite
// the approval row the caller already canceled.
func SettleUnresolvableGate(ctx context.Context, tx pgx.Tx, scope isolation.Scope, workflowID, executionID, nodeID string, now time.Time) error {
	executionID = strings.TrimSpace(executionID)
	nodeID = strings.TrimSpace(nodeID)
	if !authz.ValidUUID(executionID) || nodeID == "" {
		return nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	if authz.ValidUUID(workflowID) {
		var deleted bool
		err := tx.QueryRow(ctx, `
			SELECT deleted_at IS NOT NULL FROM workflows WHERE id = $1::uuid
		`, workflowID).Scan(&deleted)
		if err != nil {
			if errors.Is(mapDBErr(err), ErrNotFound) {
				return stopExecutionWorkflowDeletedTx(ctx, tx, scope, now, executionID)
			}
			return mapDBErr(err)
		}
		if deleted {
			return stopExecutionWorkflowDeletedTx(ctx, tx, scope, now, executionID)
		}
	}
	var stepID string
	err := tx.QueryRow(ctx, `
		SELECT s.id::text
		  FROM execution_steps s
		  JOIN execution_jobs j
		    ON j.workspace_id = s.workspace_id AND j.execution_step_id = s.id
		 WHERE s.execution_id = $1::uuid
		   AND s.node_id = $2
		   AND s.node_type = 'flow.approval'
		   AND s.status = 'waiting'
		   AND j.status = 'waiting'
		 ORDER BY s.attempt DESC
		 LIMIT 1
	`, executionID, nodeID).Scan(&stepID)
	if err != nil {
		if errors.Is(mapDBErr(err), ErrNotFound) {
			return nil
		}
		return mapDBErr(err)
	}
	errRaw, err := marshalObject(requirementUnresolvableStepError())
	if err != nil {
		return ErrInvalid
	}
	tag, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		SET status = 'failed',
		    worker_id = NULL,
		    lease_expires_at = NULL,
		    updated_at = $1
		WHERE execution_step_id = $2::uuid AND status = 'waiting'
	`, now, stepID)
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'failed',
		    error_redacted = $2::jsonb,
		    finished_at = COALESCE(finished_at, $1),
		    updated_at = $1
		WHERE id = $3::uuid
	`, now, errRaw, stepID); err != nil {
		return mapDBErr(err)
	}
	if err := rollupExecutionTx(ctx, tx, executionID, now); err != nil {
		return err
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "job.fail",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      "failed",
		Details:      map[string]any{"reason": ReasonRequirementUnresolvable, "nodeId": nodeID},
	})
	return err
}

func requirementUnresolvableStepError() map[string]any {
	return map[string]any{
		"code":    ReasonRequirementUnresolvable,
		"message": "The approval requirement could not be rebuilt.",
	}
}
