package wfstore

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/jackc/pgx/v5"
)

// ItemStatus values on execution_step_items (E3.5).
const (
	ItemStatusSucceeded     = "succeeded"
	ItemStatusFailed        = "failed"
	ItemStatusIndeterminate = "indeterminate"
	// ItemStatusUnknown is in-flight (not yet terminal). Lease loss flips
	// unknown → indeterminate and never auto-retries those items.
	ItemStatusUnknown = "unknown"
)

// attachStepOnError sets step.OnError from the run's pinned YAML (claim path).
func attachStepOnError(yamlDoc string, step *ExecutionStep) {
	if step == nil || yamlDoc == "" {
		return
	}
	mode, _ := nodeOnError(yamlDoc, step.NodeID)
	step.OnError = mode
}

// acceptItemRouting returns route only when Mode matches the pinned node's
// onError (continue or errorOutput). A stop/empty pin or a mismatched Mode
// is ignored so a job-ticket holder cannot open error edges or mark
// succeededWithErrors (#649 parity: pinned YAML is authoritative).
func acceptItemRouting(yamlDoc, nodeID string, route *ItemRouting) *ItemRouting {
	if route == nil {
		return nil
	}
	mode, _ := nodeOnError(yamlDoc, nodeID)
	if mode != ErrorHandlingContinue && mode != ErrorHandlingOutput {
		return nil
	}
	if route.Mode != mode {
		return nil
	}
	if route.Count < 1 {
		return nil
	}
	return &ItemRouting{Mode: mode, Count: route.Count}
}

// applyItemRoutingLocked marks a just-completed step as succeededWithErrors
// after per-item onError routed some items. Job stays succeeded. Writes one
// step.error_routed audit with counts only.
func (m *Memory) applyItemRoutingLocked(scope isolation.Scope, exec *memExecution, step *ExecutionStep, route ItemRouting, now time.Time) {
	if route.Mode != ErrorHandlingContinue && route.Mode != ErrorHandlingOutput {
		return
	}
	if route.Count < 1 {
		return
	}
	applyStepStatus(step, ExecutionSucceededWithErrors, now)
	step.Error = withErrorHandling(map[string]any{}, route.Mode)
	step.ErrorHandling = route.Mode
	m.appendAuditLocked(scope, itemErrorRoutedAudit(exec.record.ID, *step, route), now)
}

func itemErrorRoutedAudit(executionID string, step ExecutionStep, route ItemRouting) AuditWrite {
	port := workflow.ErrorPortName
	if route.Mode == ErrorHandlingContinue {
		port = workflow.PrimaryOutput(step.NodeType)
		if port == "" {
			port = "result"
		}
	}
	return AuditWrite{
		Action:       ActionStepErrorRouted,
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      route.Mode,
		Details: map[string]any{
			"mode":    route.Mode,
			"port":    port,
			"nodeId":  step.NodeID,
			"attempt": step.Attempt,
			"count":   route.Count,
		},
	}
}

func applyItemRoutingTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, exec Execution, step ExecutionStep, route ItemRouting, now time.Time) (ExecutionStep, error) {
	if route.Mode != ErrorHandlingContinue && route.Mode != ErrorHandlingOutput {
		return step, nil
	}
	if route.Count < 1 {
		return step, nil
	}
	errRaw, err := marshalObject(withErrorHandling(map[string]any{}, route.Mode))
	if err != nil {
		return step, ErrInvalid
	}
	routed, err := scanStep(tx.QueryRow(ctx, `
		UPDATE execution_steps
		   SET status = $3, error_redacted = $4::jsonb, updated_at = $5,
		       finished_at = COALESCE(finished_at, $5)
		 WHERE workspace_id = $1::uuid AND id = $2::uuid
		RETURNING `+stepColumns, scope.WorkspaceID(), step.ID, ExecutionSucceededWithErrors, errRaw, now))
	if err != nil {
		return step, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, itemErrorRoutedAudit(exec.ID, routed, route)); err != nil {
		return step, err
	}
	return routed, nil
}

// markStepItemsIndeterminateTx sets status=indeterminate on every item of
// a step that is not already terminal-failed. Used on lease loss (E3.5).
// Items already succeeded stay succeeded (recorded before the loss).
func markStepItemsIndeterminateTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, stepID string) (int64, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE execution_step_items
		   SET status = $3
		 WHERE workspace_id = $1::uuid AND step_id = $2::uuid
		   AND status = $4
	`, scope.WorkspaceID(), stepID, ItemStatusIndeterminate, ItemStatusUnknown)
	if err != nil {
		return 0, mapDBErr(err)
	}
	return tag.RowsAffected(), nil
}
