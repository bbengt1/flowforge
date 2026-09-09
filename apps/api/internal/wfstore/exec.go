package wfstore

import (
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/ssh"
)

type preparedStart struct {
	key         string
	fingerprint string
	input       map[string]any
	policy      map[string]any
}

func prepareStart(scope isolation.Scope, workflowID string, in StartInput) (preparedStart, error) {
	if scope.Zero() {
		return preparedStart{}, ErrNoScope
	}
	if strings.TrimSpace(in.VersionID) == "" {
		return preparedStart{}, ErrDraftNotRunnable
	}
	if !authz.ValidUUID(workflowID) {
		return preparedStart{}, ErrNotFound
	}
	if !authz.ValidUUID(in.VersionID) {
		return preparedStart{}, ErrInvalid
	}
	if in.TriggerID != "" && !authz.ValidUUID(in.TriggerID) {
		return preparedStart{}, ErrInvalid
	}
	if err := validateIdempotencyKey(in.IdempotencyKey); err != nil {
		return preparedStart{}, err
	}
	input, err := boundInput(in.Input)
	if err != nil {
		return preparedStart{}, err
	}
	input = redactObject(input)
	policy := redactObject(in.PolicySnapshot)
	if policy == nil {
		policy = map[string]any{}
	}
	key := strings.TrimSpace(in.IdempotencyKey)
	var fp string
	if key != "" {
		fp, err = fingerprintIdempotency(scope.WorkspaceID(), in.VersionID, scope.ActorID(), in.TriggerID, in.Input)
		if err != nil {
			return preparedStart{}, ErrInvalid
		}
	}
	return preparedStart{key: key, fingerprint: fp, input: input, policy: policy}, nil
}

func materializePlan(executionID string, nodes []plannedNode, now time.Time) ([]ExecutionStep, []ExecutionJob) {
	steps := make([]ExecutionStep, 0, len(nodes))
	jobs := make([]ExecutionJob, 0, len(nodes))
	for _, node := range nodes {
		step := ExecutionStep{
			ID:             newID(),
			ExecutionID:    executionID,
			NodeID:         node.ID,
			NodeType:       node.Type,
			Attempt:        1,
			Status:         ExecutionQueued,
			PolicySnapshot: retrySnapshotFromNode(node.Type, node.With),
			TargetSnapshot: map[string]any{},
			Input:          redactObject(node.With),
			Output:         map[string]any{},
			Error:          map[string]any{},
			CreatedAt:      now,
			UpdatedAt:      now,
		}
		job := ExecutionJob{
			ID:              newID(),
			ExecutionID:     executionID,
			ExecutionStepID: step.ID,
			Status:          JobQueued,
			AvailableAt:     now,
			Attempt:         1,
			CreatedAt:       now,
			UpdatedAt:       now,
		}
		steps = append(steps, step)
		jobs = append(jobs, job)
	}
	return steps, jobs
}

func retrySnapshotFromNode(nodeType string, with map[string]any) map[string]any {
	if nodeType != ssh.NodeSSHRun {
		return map[string]any{}
	}
	return map[string]any{
		"maxAttempts": ssh.MaxAttemptsFromWith(with),
	}
}

func cloneExecution(exec Execution, wf Workflow) Execution {
	out := exec
	out.WorkflowSlug = wf.Slug
	out.WorkflowName = wf.Name
	out.Input = cloneObject(exec.Input)
	out.PolicySnapshot = cloneObject(exec.PolicySnapshot)
	if out.Input == nil {
		out.Input = map[string]any{}
	}
	if out.PolicySnapshot == nil {
		out.PolicySnapshot = map[string]any{}
	}
	return out
}

func newAudit(scope isolation.Scope, in AuditWrite, now time.Time) AuditEvent {
	return AuditEvent{
		ID:             newID(),
		ActorID:        scope.ActorID(),
		HostContext:    redactObject(in.HostContext),
		Action:         strings.TrimSpace(in.Action),
		ResourceType:   strings.TrimSpace(in.ResourceType),
		ResourceID:     strings.TrimSpace(in.ResourceID),
		Outcome:        strings.TrimSpace(in.Outcome),
		CorrelationID:  strings.TrimSpace(in.CorrelationID),
		Details:        redactObject(in.Details),
		OccurredAt:     now,
		RetentionUntil: now.Add(DefaultAuditRetention),
	}
}
