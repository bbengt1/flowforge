package wfstore

import (
	"context"
	"errors"
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
// YAML and, for flow.fail, its with.code when it is a literal (no template
// or expression; "" otherwise). Anything but continue/errorOutput
// (including a parse failure) is stop.
func nodeOnError(yamlDoc, nodeID string) (string, string) {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return "", ""
	}
	for _, n := range res.Document.Spec.Nodes {
		if n.ID != nodeID {
			continue
		}
		literal := ""
		if c, ok := n.With["code"].(string); ok && n.Type == "flow.fail" && workflow.LiteralFailCode(c) {
			literal = c
		}
		switch n.OnError {
		case workflow.OnErrorContinue:
			// Fail closed: continue needs a primary output.
			if workflow.PrimaryOutput(n.Type) == "" {
				return "", ""
			}
			return n.OnError, literal
		case workflow.OnErrorOutput:
			return n.OnError, literal
		}
		return "", ""
	}
	return "", ""
}

// routableCodes is the allowlist (H1, fail closed) of system failure codes
// onError may route: ordinary node and runtime failures where the step ran
// and its target reported an error. Everything else is never routed and
// fails the run as before: policy, authz, isolation, egress, artifact and
// emergency-stop codes, engine-internal codes, and any code not listed
// here (including codes added later until someone lists them on purpose).
// Shared by both stores.
var routableCodes = map[string]struct{}{
	"timeout":             {}, // ssh, http, kubernetes
	"connect-failed":      {}, // ssh.run
	"command-failed":      {}, // ssh.run
	"delivery-failed":     {}, // http / notify
	"dry-run-failed":      {}, // kubernetes.*
	"apply-failed":        {}, // kubernetes.*
	"read-failed":         {}, // kubernetes.*
	"rollout-failed":      {}, // kubernetes.*
	"cluster-unreachable": {}, // kubernetes.*
	"script-failed":       {}, // script.run, generic non-zero exit
}

// errorPortCodeMax caps the code on the error port payload (L2).
const errorPortCodeMax = 64

// routableFailure reports whether onError may route this failure. Only
// two shapes route:
//   - a code on routableCodes, or
//   - a flow.fail step's own operator code: a dotted token (team.reason),
//     equal to the with.code written as a LITERAL in the pinned YAML
//     (pinnedCode). A templated with.code never routes, so run input can
//     never choose which code routes. Dotted tokens never collide
//     with system codes (all DNS labels), so a flow.fail that imitates a
//     security code (egress-denied, emergency-stopped) is never routed.
//
// Cancel, lease loss (indeterminate) and unresolvable approvals do not
// come through FailJob routing at all.
func routableFailure(step ExecutionStep, errObj map[string]any, pinnedCode string) bool {
	code, _ := errObj["code"].(string)
	if code == "" || len(code) > errorPortCodeMax {
		return false
	}
	if _, ok := routableCodes[code]; ok {
		return true
	}
	if step.NodeType != "flow.fail" || !strings.Contains(code, ".") {
		return false
	}
	return pinnedCode != "" && pinnedCode == code
}

// errorPortPayload is the object on the error port: code, safe message,
// nodeId, attempt. Never step input or output.
func errorPortPayload(step ExecutionStep, errObj map[string]any) map[string]any {
	code, _ := errObj["code"].(string)
	code = strings.TrimSpace(code)
	if len(code) > errorPortCodeMax {
		code = strings.ToValidUTF8(code[:errorPortCodeMax], "")
	}
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
	yamlDoc, err := pinnedVersionYAMLTx(ctx, tx, scope, exec.WorkflowVersionID)
	if err != nil {
		return step, err
	}
	mode, pinnedCode := nodeOnError(yamlDoc, step.NodeID)
	if mode == "" || !routableFailure(step, errObj, pinnedCode) {
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
	// M1: the pinned Version.DefinitionYAML in both stores (Postgres reads
	// the same field via pinnedVersionYAMLTx). A missing version is stop.
	var yamlDoc string
	for _, v := range m.versions[exec.record.WorkflowID] {
		if v.ID == exec.record.WorkflowVersionID {
			yamlDoc = v.DefinitionYAML
		}
	}
	mode, pinnedCode := nodeOnError(yamlDoc, step.NodeID)
	if mode == "" || !routableFailure(*step, step.Error, pinnedCode) {
		return
	}
	output, ports := routeFailure(mode, *step, step.Error)
	step.Output = output
	step.Error = withErrorHandling(step.Error, mode)
	releaseFrom(exec.steps, exec.jobs, exec.edges, step.NodeID, ports, now)
	m.appendAuditLocked(scope, errorRoutedAudit(exec.record.ID, *step, mode), now)
}

// pinnedVersionYAMLTx returns the run's pinned Version.DefinitionYAML (the
// workflow_versions.normalized_yaml column, the same field Memory reads).
// A missing version row is not an error: it returns "" and the failure is
// treated as stop, so the fail transaction still commits (M1). Only real
// database errors are returned.
func pinnedVersionYAMLTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, versionID string) (string, error) {
	if versionID == "" {
		return "", nil
	}
	var yamlDoc string
	err := tx.QueryRow(ctx, `
		SELECT v.normalized_yaml FROM workflow_versions v
		 WHERE v.workspace_id = $1::uuid AND v.id = $2::uuid
	`, scope.WorkspaceID(), versionID).Scan(&yamlDoc)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", mapDBErr(err)
	}
	return yamlDoc, nil
}
