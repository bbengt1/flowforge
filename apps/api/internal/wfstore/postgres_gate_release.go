package wfstore

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/approvalgate"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
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
	return settleUnresolvableGate(ctx, tx, scope, workflowID, executionID, nodeID, now, requirementUnresolvableStepError())
}

// Group and membership changes in identity re-check waiting gates through
// approvalgate, which cannot import this package (identity would then
// depend on wfstore). Register the settler here so every binary that
// links wfstore closes those gates exactly as a park-time
// no-eligible-decider failure.
func init() {
	approvalgate.RegisterSettler(func(ctx context.Context, tx pgx.Tx, workspaceID, workflowID, executionID, nodeID string, now time.Time) error {
		scope, err := isolation.AuthorizeSystem(workspaceID)
		if err != nil {
			return err
		}
		return SettleNoEligibleDeciderGate(ctx, tx, scope, workflowID, executionID, nodeID, now)
	})
}

// SettleNoEligibleDeciderGate is SettleUnresolvableGate with the step
// error details.cause no_eligible_decider (boot resync found that nobody
// but the requester could decide a targeted gate).
func SettleNoEligibleDeciderGate(ctx context.Context, tx pgx.Tx, scope isolation.Scope, workflowID, executionID, nodeID string, now time.Time) error {
	return settleUnresolvableGate(ctx, tx, scope, workflowID, executionID, nodeID, now, NoEligibleDeciderError())
}

func settleUnresolvableGate(ctx context.Context, tx pgx.Tx, scope isolation.Scope, workflowID, executionID, nodeID string, now time.Time, stepErr map[string]any) error {
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
	errRaw, err := marshalObject(stepErr)
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

// ErrNoEligibleDecider is returned by WaitJob when a targeted gate has
// no possible decider besides the requester. Nothing is written; the
// caller fails the job with NoEligibleDeciderError.
var ErrNoEligibleDecider = parkedapproval.ErrNoEligibleDecider

// NoEligibleDeciderError is the step error for a targeted gate that
// nobody but the requester could ever decide.
func NoEligibleDeciderError() map[string]any {
	out := requirementUnresolvableStepError()
	out["message"] = "No one other than the requester can decide this approval."
	out["details"] = map[string]any{"cause": parkedapproval.CauseNoEligibleDecider}
	return out
}

// RequirementUnresolvableError is the job and step failure compose writes
// when a pinned approval requirement cannot be rebuilt. FailJob stores
// this code, cancels a pending approval for that execution and node, and
// rolls the run up so statusReason is requirement_unresolvable.
func RequirementUnresolvableError() map[string]any {
	return requirementUnresolvableStepError()
}

// MissingActorError fails a claimed job that belongs to a manual or API
// run with no requester. The runner does not execute that job.
func MissingActorError() map[string]any {
	return map[string]any{
		"code":    ReasonMissingActor,
		"message": MissingActorDetail,
	}
}

func requirementUnresolvableStepError() map[string]any {
	return map[string]any{
		"code":    ReasonRequirementUnresolvable,
		"message": "The approval requirement could not be rebuilt.",
	}
}
