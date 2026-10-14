package wfstore

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"

	"github.com/jackc/pgx/v5"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Workspace error workflow (#649 S3).
//
// A workspace admin may name one published workflow whose only trigger is
// the `error` system trigger. When an automated run in that workspace
// ends failed (with a code S2's shared check would route) or
// indeterminate, the engine starts one run of it, inside the same
// transaction that stores the parent's terminal status. The decision is
// errorWorkflowDecision, shared by both stores.

// TriggerError is the stored trigger type of an error-workflow run.
const TriggerError = workflow.TriggerTypeError

// Audit actions.
const (
	ActionErrorWorkflowSet     = "workspace.error_workflow.set"
	ActionErrorWorkflowCleared = "workspace.error_workflow.cleared"
	ActionErrorWorkflowFired   = "execution.error_workflow.fired"
	ActionErrorWorkflowSkipped = "execution.error_workflow.skipped"
)

// Fire reasons (the payload's reason field).
const (
	ErrorReasonFailed        = "failed"
	ErrorReasonIndeterminate = "indeterminate"
)

// Skip reasons, audited when the workspace has an error workflow but this
// run does not start it.
const (
	ErrorSkipCodeNotEligible = "code_not_eligible"
	ErrorSkipTargetMissing   = "target_missing"
	ErrorSkipTargetDeleted   = "target_deleted"
	ErrorSkipTargetDraft     = "target_unpublished"
	ErrorSkipTargetDisabled  = "target_disabled"
	ErrorSkipTargetNotError  = "target_not_error_workflow"
	// Pre-start policy gate (the same evaluation schedule and webhook
	// starts run). Fail closed.
	ErrorSkipPolicyDenied      = "policy_denied"
	ErrorSkipApprovalRequired  = "approval_required"
	ErrorSkipPolicyUnavailable = "policy_unavailable"
	ErrorSkipStartFailed       = "start_failed"
	ErrorSkipCapReached        = "cap_reached"
)

// ErrorWorkflowGate evaluates the target version before an error run
// starts and returns a skip reason, or "" to start. tx is the rollup
// transaction (Postgres) or nil (Memory). It must not write.
type ErrorWorkflowGate func(ctx context.Context, tx pgx.Tx, scope isolation.Scope, ver Version) string

var postgresErrorGate atomic.Pointer[ErrorWorkflowGate]

// SetErrorWorkflowGate installs the policy gate the Postgres store uses
// when it starts an error-workflow run. Wiring is per process (the API
// server and the runner both roll runs up). With no gate installed every
// fire is skipped with policy_unavailable (fail closed).
func SetErrorWorkflowGate(g ErrorWorkflowGate) {
	if g == nil {
		postgresErrorGate.Store(nil)
		return
	}
	postgresErrorGate.Store(&g)
}

var errorOpenCap atomic.Int64

// SetErrorWorkflowOpenCap sets the workspace open-run cap the Postgres store
// applies to error-workflow runs (the same value CapStart applies to other
// starts). n <= 0 means unlimited, as for StartInput.MaxOpen.
func SetErrorWorkflowOpenCap(n int) { errorOpenCap.Store(int64(n)) }

func errorWorkflowOpenCap() int { return int(errorOpenCap.Load()) }

// errorFireFaultHook lets tests inject a failure mid fire path (after the
// error run row exists) to prove the savepoint isolates the parent. Nil in
// production.
var errorFireFaultHook atomic.Pointer[func() error]

func errorFireFault() error {
	if h := errorFireFaultHook.Load(); h != nil {
		return (*h)()
	}
	return nil
}

func currentErrorGate() ErrorWorkflowGate {
	if g := postgresErrorGate.Load(); g != nil {
		return *g
	}
	return nil
}

// ErrorWorkflowSetting is a workspace's configured error workflow.
type ErrorWorkflowSetting struct {
	WorkflowID   string `json:"workflowId"`
	WorkflowName string `json:"workflowName"`
	WorkflowSlug string `json:"workflowSlug"`
}

// errorParentEligible reports whether a run's trigger may fire the error
// workflow at all. Manual (and unspecified) runs, operator-retried runs,
// and error-workflow runs never do; api, schedule, webhook, resync and
// any other automated trigger do.
func errorParentEligible(triggerType, errorParentID string, operatorRetried bool) bool {
	if strings.TrimSpace(errorParentID) != "" || operatorRetried {
		return false
	}
	switch strings.TrimSpace(triggerType) {
	case "", "manual", TriggerError:
		return false
	}
	return true
}

// errorWorkflowCause returns the step that ended the run: for failed, the
// most recent failed step whose failure onError did not handle (run_ended
// close-outs excluded); for indeterminate, the most recent indeterminate
// step.
func errorWorkflowCause(status string, steps []ExecutionStep) (ExecutionStep, bool) {
	var best ExecutionStep
	found := false
	for _, st := range steps {
		switch status {
		case ExecutionFailed:
			if st.Status != ExecutionFailed || stepErrorHandling(st) != "" {
				continue
			}
			if code, _ := st.Error["code"].(string); code == ReasonRunEnded {
				continue
			}
		case ExecutionIndeterminate:
			if st.Status != ExecutionIndeterminate {
				continue
			}
		default:
			return ExecutionStep{}, false
		}
		if !found || stepEndedAfter(st, best) {
			best = st
			found = true
		}
	}
	return best, found
}

func stepEndedAfter(a, b ExecutionStep) bool {
	at, bt := a.UpdatedAt, b.UpdatedAt
	if a.FinishedAt != nil {
		at = *a.FinishedAt
	}
	if b.FinishedAt != nil {
		bt = *b.FinishedAt
	}
	if !at.Equal(bt) {
		return at.After(bt)
	}
	return a.Attempt > b.Attempt
}

// errorWorkflowDecision decides whether a run that just became status
// fires the error workflow. It returns the reason (failed or
// indeterminate) and the cause step, or a skip reason. An empty skip and
// fire=false means "not a candidate" (no audit row). pinnedYAML is the
// parent's pinned version YAML, for S2's flow.fail literal-code check.
func errorWorkflowDecision(status string, steps []ExecutionStep, pinnedYAML string) (fire bool, reason, skip string, cause ExecutionStep) {
	switch status {
	case ExecutionIndeterminate:
		cause, _ = errorWorkflowCause(status, steps)
		return true, ErrorReasonIndeterminate, "", cause
	case ExecutionFailed:
		st, ok := errorWorkflowCause(status, steps)
		if !ok {
			return false, "", ErrorSkipCodeNotEligible, ExecutionStep{}
		}
		if !routableFailure(st, st.Error, pinnedFailCode(pinnedYAML, st.NodeID)) {
			return false, "", ErrorSkipCodeNotEligible, st
		}
		return true, ErrorReasonFailed, "", st
	}
	return false, "", "", ExecutionStep{}
}

// errorTargetSkip checks the configured target at fire time. It returns
// "" when the target may start.
func errorTargetSkip(found, deleted bool, status string, ver *Version) string {
	switch {
	case !found:
		return ErrorSkipTargetMissing
	case deleted:
		return ErrorSkipTargetDeleted
	case status == "archived":
		return ErrorSkipTargetDisabled
	case status != "published" || ver == nil:
		return ErrorSkipTargetDraft
	case !workflow.IsOnlyErrorTriggerYAML(ver.DefinitionYAML):
		return ErrorSkipTargetNotError
	}
	return ""
}

// errorWorkflowPayload is the error run's input: the parent's trigger
// type, run, workflow and version, the cause node, and its code and
// message with S2's caps. Never step input, trigger metadata or secrets.
func errorWorkflowPayload(parent Execution, versionNumber int, reason string, cause ExecutionStep) map[string]any {
	errObj := cause.Error
	if errObj == nil {
		errObj = map[string]any{}
	}
	capped := errorPortPayload(cause, errObj)
	return map[string]any{
		"reason":            reason,
		"triggerType":       ExecutionTriggerType(parent),
		"executionId":       parent.ID,
		"workflowId":        parent.WorkflowID,
		"workflowName":      parent.WorkflowName,
		"workflowVersionId": parent.WorkflowVersionID,
		"workflowVersion":   versionNumber,
		"nodeId":            cause.NodeID,
		"code":              capped["code"],
		"message":           capped["message"],
	}
}

func errorFiredAudit(parent Execution, child Execution, targetID, reason string, cause ExecutionStep) AuditWrite {
	code, _ := errorPortPayload(cause, cause.Error)["code"].(string)
	return AuditWrite{
		Action:        ActionErrorWorkflowFired,
		ResourceType:  "execution",
		ResourceID:    parent.ID,
		Outcome:       "fired",
		CorrelationID: parent.CorrelationID,
		Details: map[string]any{
			"reason":           reason,
			"errorExecutionId": child.ID,
			"errorWorkflowId":  targetID,
			"parentActorId":    parent.RequestedBy,
			"nodeId":           cause.NodeID,
			"code":             code,
		},
	}
}

func errorSkippedAudit(parent Execution, targetID, skip string) AuditWrite {
	return AuditWrite{
		Action:        ActionErrorWorkflowSkipped,
		ResourceType:  "execution",
		ResourceID:    parent.ID,
		Outcome:       "skipped",
		CorrelationID: parent.CorrelationID,
		Details:       map[string]any{"reason": skip, "errorWorkflowId": targetID},
	}
}

func errorRunPolicy(ver Version) map[string]any {
	return map[string]any{
		"triggerType":       TriggerError,
		"workflowVersionId": ver.ID,
		"workflowDigest":    ver.Digest,
	}
}

// ErrErrorWorkflowTarget refuses a target that is not a live, published
// workflow in this workspace whose only trigger is `error`.
var ErrErrorWorkflowTarget = errors.New("error workflow target must be a published workflow in this workspace whose only trigger is error")

// ErrorWorkflowStore is implemented by both stores.
type ErrorWorkflowStore interface {
	GetErrorWorkflow(ctx context.Context, scope isolation.Scope) (ErrorWorkflowSetting, bool, error)
	SetErrorWorkflow(ctx context.Context, scope isolation.Scope, workflowID string, actor AuditActor) (ErrorWorkflowSetting, error)
	ClearErrorWorkflow(ctx context.Context, scope isolation.Scope, actor AuditActor) (bool, error)
}

// AuditActor names the admin on set/clear audit rows (display name plus
// UUID) and carries the request id.
type AuditActor struct {
	DisplayName string
	RequestID   string
}

func errorWorkflowSetAudit(scope isolation.Scope, actor AuditActor, wf Workflow, previous string) AuditWrite {
	return AuditWrite{
		Action:       ActionErrorWorkflowSet,
		ResourceType: "workspace",
		ResourceID:   scope.WorkspaceID(),
		Outcome:      "set",
		HostContext:  map[string]any{"requestId": actor.RequestID},
		Details: map[string]any{
			"actorId":            scope.ActorID(),
			"actorDisplayName":   actor.DisplayName,
			"workflowId":         wf.ID,
			"workflowName":       wf.Name,
			"previousWorkflowId": previous,
		},
	}
}

func errorWorkflowClearedAudit(scope isolation.Scope, actor AuditActor, previous string) AuditWrite {
	return AuditWrite{
		Action:       ActionErrorWorkflowCleared,
		ResourceType: "workspace",
		ResourceID:   scope.WorkspaceID(),
		Outcome:      "cleared",
		HostContext:  map[string]any{"requestId": actor.RequestID},
		Details: map[string]any{
			"actorId":            scope.ActorID(),
			"actorDisplayName":   actor.DisplayName,
			"previousWorkflowId": previous,
		},
	}
}

// adminScope refuses a zero or system scope: set/clear is a person's act.
func adminScope(scope isolation.Scope) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if scope.System() || strings.TrimSpace(scope.ActorID()) == "" {
		return ErrInvalid
	}
	return nil
}

// pinnedFailCode is the literal with.code of a flow.fail node in the
// pinned YAML ("" for a templated code, another type, or a parse
// failure). It is the same literal S2's routableFailure compares, read
// whatever the node's onError mode is.
func pinnedFailCode(yamlDoc, nodeID string) string {
	res, errs := workflow.ParseAndNormalize([]byte(yamlDoc))
	if len(errs) > 0 || res == nil || res.Document == nil {
		return ""
	}
	for _, n := range res.Document.Spec.Nodes {
		if n.ID != nodeID || n.Type != "flow.fail" {
			continue
		}
		if c, ok := n.With["code"].(string); ok && workflow.LiteralFailCode(c) {
			return c
		}
	}
	return ""
}
