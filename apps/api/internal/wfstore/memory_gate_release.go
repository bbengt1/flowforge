package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

// SettleUnresolvableGate is the in-memory form of the Postgres settle.
// A missing or deleted workflow fails the run with workflow_deleted. A
// live waiting gate fails the gate step and job with
// requirement_unresolvable, cancels other waiting, pending, and blocked
// work, and fails the run. It does not emit a port.
func (m *Memory) SettleUnresolvableGate(_ context.Context, scope isolation.Scope, workflowID, executionID, nodeID string, now time.Time) error {
	if scope.Zero() {
		return ErrNoScope
	}
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
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return nil
	}
	if authz.ValidUUID(workflowID) {
		wf, found := m.workflows[workflowID]
		if !found || wf.workspaceID != scope.WorkspaceID() || wf.deletedAt != nil {
			return m.stopExecutionLocked(scope, now, executionID)
		}
	}
	stepIdx := -1
	for i := range exec.steps {
		step := exec.steps[i]
		if step.NodeID != nodeID || step.NodeType != "flow.approval" || step.Status != ExecutionWaiting {
			continue
		}
		if stepIdx < 0 || step.Attempt > exec.steps[stepIdx].Attempt {
			stepIdx = i
		}
	}
	if stepIdx < 0 {
		return nil
	}
	jobIdx := -1
	for i := range exec.jobs {
		if exec.jobs[i].ExecutionStepID == exec.steps[stepIdx].ID && exec.jobs[i].Status == JobWaiting {
			jobIdx = i
			break
		}
	}
	if jobIdx < 0 {
		return nil
	}
	errBody := requirementUnresolvableStepError()
	exec.jobs[jobIdx].Status = JobFailed
	exec.jobs[jobIdx].WorkerID = ""
	exec.jobs[jobIdx].LeaseExpiresAt = nil
	exec.jobs[jobIdx].UpdatedAt = now
	exec.steps[stepIdx].Error = errBody
	applyStepStatus(&exec.steps[stepIdx], ExecutionFailed, now)
	for i := range exec.jobs {
		if i == jobIdx {
			continue
		}
		switch exec.jobs[i].Status {
		case JobWaiting, JobBlocked:
			exec.jobs[i].Status = JobCanceled
			exec.jobs[i].WorkerID = ""
			exec.jobs[i].LeaseExpiresAt = nil
			exec.jobs[i].AvailableAt = now
			exec.jobs[i].UpdatedAt = now
		}
	}
	for i := range exec.steps {
		if i == stepIdx {
			continue
		}
		switch exec.steps[i].Status {
		case ExecutionWaiting, ExecutionPending:
			exec.steps[i].Error = errBody
			applyStepStatus(&exec.steps[i], ExecutionCanceled, now)
		}
	}
	applyExecutionStatus(&exec.record, ExecutionFailed, now)
	m.executions[executionID] = exec
	m.appendAuditLocked(scope, AuditWrite{
		Action:       "execution.stop",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonRequirementUnresolvable,
		Details:      map[string]any{"reason": ReasonRequirementUnresolvable, "nodeId": nodeID},
	}, now)
	return nil
}
