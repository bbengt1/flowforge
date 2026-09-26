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

// SettleUnresolvableGate frees a concurrency slot after an approval was
// closed because its requirement could not be rebuilt. The caller already
// holds the workflow lock (when the workflow still exists) and the
// execution lock, and takes those before approvals. A missing or deleted
// workflow follows the closed-approval path and fails the run with
// workflow_deleted. A live waiting gate fails closed: the gate step and
// job fail with requirement_unresolvable, other waiting, pending, and
// blocked work is canceled, and the run ends failed with that reason.
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
	if err := cancelOpenWorkTx(ctx, tx, executionID, errRaw, now); err != nil {
		return err
	}
	if err := applyExecutionStatusTx(ctx, tx, executionID, ExecutionFailed, now); err != nil {
		return err
	}
	if err := cancelPendingApprovalsUnresolvableTx(ctx, tx, executionID, now); err != nil {
		return err
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.stop",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonRequirementUnresolvable,
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

// cancelOpenWorkTx cancels waiting, pending, and blocked steps and jobs
// the way delete closes a parked run. The gate step and job are already
// failed, so this does not rewrite them. It does not resolve edges.
func cancelOpenWorkTx(ctx context.Context, tx pgx.Tx, executionID string, errRaw []byte, now time.Time) error {
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		SET status = 'canceled',
		    worker_id = NULL,
		    lease_expires_at = NULL,
		    available_at = $2,
		    updated_at = $2
		WHERE execution_id = $1::uuid
		  AND status IN ('waiting', 'pending', 'blocked')
	`, executionID, now); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'canceled',
		    error_redacted = $2::jsonb,
		    finished_at = COALESCE(finished_at, $3),
		    updated_at = $3
		WHERE execution_id = $1::uuid
		  AND status IN ('waiting', 'pending', 'blocked')
	`, executionID, errRaw, now); err != nil {
		return mapDBErr(err)
	}
	return nil
}

// cancelPendingApprovalsUnresolvableTx closes any approval on the run that
// is still pending. app.close_pending_approvals does not accept this reason.
func cancelPendingApprovalsUnresolvableTx(ctx context.Context, tx pgx.Tx, executionID string, now time.Time) error {
	_, err := tx.Exec(ctx, `
		WITH closed AS (
			UPDATE approvals
			   SET status = 'canceled',
			       close_reason = $2,
			       decided_by = NULL,
			       decided_at = NULL,
			       updated_at = $3
			 WHERE execution_id = $1::uuid
			   AND status = 'pending'
			RETURNING workspace_id, id
		)
		INSERT INTO approval_events (workspace_id, approval_id, event_type, actor_id, details, occurred_at)
		SELECT workspace_id, id, 'canceled', NULL, jsonb_build_object('reason', $2::text), $3
		  FROM closed
	`, executionID, ReasonRequirementUnresolvable, now)
	return mapDBErr(err)
}
