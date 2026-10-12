package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/jackc/pgx/v5"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Per-node failure routing (onError). The mode is read from the run's
// pinned workflow version when the job fails, and the decision is stored
// on the step's error object under errorHandlingKey. Reads move it to
// ExecutionStep.ErrorHandling and drop it from Error.
const (
	ErrorHandlingContinue = workflow.OnErrorContinue
	ErrorHandlingOutput   = workflow.OnErrorOutput

	errorHandlingKey = "handling"

	// ActionStepErrorRouted is written in the fail transaction when a
	// failure is routed by onError.
	ActionStepErrorRouted = "step.error_routed"

	// ReasonStepErrorHandled refuses a retry of a failure that onError
	// already routed: its outgoing edges have resolved.
	ReasonStepErrorHandled = "step_error_handled"

	errorPortMessageMax = 256
)

// nodeOnError returns the onError mode of nodeID in the pinned version
// YAML. Anything but continue/errorOutput (including a parse failure) is
// stop.
func nodeOnError(yamlDoc, nodeID string) string {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return ""
	}
	for _, n := range res.Document.Spec.Nodes {
		if n.ID == nodeID {
			switch n.OnError {
			case workflow.OnErrorContinue:
				// Fail closed: continue needs a primary output.
				if workflow.PrimaryOutput(n.Type) == "" {
					return ""
				}
				return n.OnError
			case workflow.OnErrorOutput:
				return n.OnError
			}
			return ""
		}
	}
	return ""
}

// routableFailure is false for failures onError never routes: policy
// refusals and emergency stop. Cancel, lease loss (indeterminate) and
// unresolvable approvals do not come through FailJob routing at all.
func routableFailure(errObj map[string]any) bool {
	code, _ := errObj["code"].(string)
	switch code {
	case "policy-denied", "emergency-stop-denied", ReasonRequirementUnresolvable, ReasonWorkflowDeleted:
		return false
	}
	return true
}

// errorPortPayload is the object on the error port: code, safe message,
// nodeId, attempt. Never step input or output.
func errorPortPayload(step ExecutionStep, errObj map[string]any) map[string]any {
	code, _ := errObj["code"].(string)
	msg, _ := errObj["message"].(string)
	msg = strings.TrimSpace(msg)
	if len(msg) > errorPortMessageMax {
		msg = strings.ToValidUTF8(msg[:errorPortMessageMax], "")
	}
	return map[string]any{"code": code, "message": msg, "nodeId": step.NodeID, "attempt": step.Attempt}
}

// routeFailure returns the step output and the ports released for a
// handled failure. continue releases the main port with {}; errorOutput
// releases only the error port with the error payload. Every other edge
// leaving the node resolves unsatisfied (branch_not_taken downstream).
func routeFailure(mode string, step ExecutionStep, errObj map[string]any) (map[string]any, map[string]struct{}) {
	switch mode {
	case ErrorHandlingContinue:
		port := workflow.PrimaryOutput(step.NodeType)
		return map[string]any{port: map[string]any{}}, map[string]struct{}{port: {}}
	case ErrorHandlingOutput:
		return map[string]any{workflow.ErrorPortName: errorPortPayload(step, errObj)}, map[string]struct{}{workflow.ErrorPortName: {}}
	}
	return nil, nil
}

// stepErrorHandling is the stored routing decision of a failed step.
func stepErrorHandling(step ExecutionStep) string {
	if step.ErrorHandling != "" {
		return step.ErrorHandling
	}
	if step.Status != ExecutionFailed || step.Error == nil {
		return ""
	}
	mode, _ := step.Error[errorHandlingKey].(string)
	switch mode {
	case ErrorHandlingContinue, ErrorHandlingOutput:
		return mode
	}
	return ""
}

// liftErrorHandling moves the stored marker from Error to ErrorHandling
// for API reads.
func liftErrorHandling(step *ExecutionStep) {
	step.ErrorHandling = stepErrorHandling(*step)
	if step.Error != nil {
		if _, ok := step.Error[errorHandlingKey]; ok {
			cp := make(map[string]any, len(step.Error))
			for k, v := range step.Error {
				if k != errorHandlingKey {
					cp[k] = v
				}
			}
			step.Error = cp
		}
	}
}

func withErrorHandling(errObj map[string]any, mode string) map[string]any {
	out := map[string]any{}
	for k, v := range errObj {
		out[k] = v
	}
	out[errorHandlingKey] = mode
	return out
}

func errorRoutedAudit(executionID string, step ExecutionStep, mode string) AuditWrite {
	port := workflow.ErrorPortName
	if mode == ErrorHandlingContinue {
		port = workflow.PrimaryOutput(step.NodeType)
	}
	return AuditWrite{
		Action:       ActionStepErrorRouted,
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      mode,
		Details:      map[string]any{"mode": mode, "port": port, "nodeId": step.NodeID, "attempt": step.Attempt},
	}
}

// Routing happens on the failing FailJob. The store has no automatic
// retries today; if automatic retries are added, routing must wait for
// the last attempt so onError never preempts a retry.
//
// routeFailureTx applies onError from the run's pinned version to a step
// that just failed (Postgres). stop leaves the step unchanged.
func routeFailureTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, exec Execution, step ExecutionStep, errObj map[string]any, now time.Time) (ExecutionStep, error) {
	var yamlDoc string
	if err := tx.QueryRow(ctx, `
		SELECT v.normalized_yaml FROM workflow_versions v
		 WHERE v.workspace_id = $1::uuid AND v.id = $2::uuid
	`, scope.WorkspaceID(), exec.WorkflowVersionID).Scan(&yamlDoc); err != nil {
		return step, mapDBErr(err)
	}
	mode := nodeOnError(yamlDoc, step.NodeID)
	if mode == "" {
		return step, nil
	}
	output, ports := routeFailure(mode, step, errObj)
	outRaw, err := marshalObject(output)
	if err != nil {
		return step, ErrInvalid
	}
	errRaw, err := marshalObject(withErrorHandling(errObj, mode))
	if err != nil {
		return step, ErrInvalid
	}
	routed, err := scanStep(tx.QueryRow(ctx, `
		UPDATE execution_steps SET output_redacted = $3::jsonb, error_redacted = $4::jsonb, updated_at = $5
		 WHERE workspace_id = $1::uuid AND id = $2::uuid
		RETURNING `+stepColumns, scope.WorkspaceID(), step.ID, outRaw, errRaw, now))
	if err != nil {
		return step, err
	}
	if err := resolveOutgoingTx(ctx, tx, exec.ID, step.NodeID, ports, now); err != nil {
		return step, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, errorRoutedAudit(exec.ID, routed, mode)); err != nil {
		return step, err
	}
	return routed, nil
}

// routeFailureLocked is the Memory twin. The caller holds m.mu.
func (m *Memory) routeFailureLocked(scope isolation.Scope, exec *memExecution, step *ExecutionStep, now time.Time) {
	if !routableFailure(step.Error) {
		return
	}
	var yamlDoc string
	for _, v := range m.versions[exec.record.WorkflowID] {
		if v.ID == exec.record.WorkflowVersionID {
			yamlDoc = v.DefinitionYAML
		}
	}
	mode := nodeOnError(yamlDoc, step.NodeID)
	if mode == "" {
		return
	}
	output, ports := routeFailure(mode, *step, step.Error)
	step.Output = output
	step.Error = withErrorHandling(step.Error, mode)
	releaseFrom(exec.steps, exec.jobs, exec.edges, step.NodeID, ports, now)
	m.appendAuditLocked(scope, errorRoutedAudit(exec.record.ID, *step, mode), now)
}
