package wfstore

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func (m *Memory) Delete(ctx context.Context, scope isolation.Scope, id string) (DeleteResult, error) {
	if scope.Zero() {
		return DeleteResult{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return DeleteResult{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() || row.deletedAt != nil {
		return DeleteResult{}, ErrNotFound
	}
	runWorkflowRowLockHook(ctx)
	impact, parked := classifyDeleteRuns(m.openRunsLocked(scope, id))
	if impact.Blocked {
		return DeleteResult{}, ErrActiveExecutions
	}
	now := time.Now().UTC()
	for _, executionID := range parked {
		if err := m.closeParkedLocked(scope, now, executionID); err != nil {
			return DeleteResult{}, err
		}
	}
	published := row.record.Status == StatusPublished
	row.record.Status = StatusDraft
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = now
	row.deletedAt = &now
	m.workflows[id] = row
	details := map[string]any{
		"actorId":     scope.ActorID(),
		"workspaceId": scope.WorkspaceID(),
		"workflowId":  id,
		"name":        row.record.Name,
		"published":   published,
	}
	if tenantID := scope.TenantID(); tenantID != "" {
		details["tenantId"] = tenantID
	}
	m.audits = append(m.audits, memAudit{
		workspaceID: scope.WorkspaceID(),
		record: newAudit(scope, AuditWrite{
			Action:       "workflow.deleted",
			ResourceType: "workflow",
			ResourceID:   id,
			Outcome:      "deleted",
			Details:      details,
		}, now),
	})
	return DeleteResult{ID: id, Name: row.record.Name, Published: published}, nil
}

func (m *Memory) DeleteImpact(_ context.Context, scope isolation.Scope, id string) (DeleteImpact, error) {
	if scope.Zero() {
		return DeleteImpact{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return DeleteImpact{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.workflows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() || row.deletedAt != nil {
		return DeleteImpact{}, ErrNotFound
	}
	impact, _ := classifyDeleteRuns(m.openRunsLocked(scope, id))
	return impact, nil
}

func (m *Memory) openRunsLocked(scope isolation.Scope, workflowID string) []openRun {
	var runs []openRun
	for id, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() || exec.record.WorkflowID != workflowID {
			continue
		}
		if isTerminalExecution(exec.record.Status) {
			continue
		}
		runs = append(runs, openRun{
			id:     id,
			jobs:   append([]ExecutionJob(nil), exec.jobs...),
			steps:  append([]ExecutionStep(nil), exec.steps...),
			status: exec.record.Status,
		})
	}
	return runs
}

func (m *Memory) closeParkedLocked(scope isolation.Scope, now time.Time, executionID string) error {
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return ErrNotFound
	}
	if isTerminalExecution(exec.record.Status) && exec.record.Status != ExecutionPinned {
		return nil
	}
	errBody := workflowDeletedStepError()
	for i := range exec.jobs {
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
		Outcome:      ReasonWorkflowDeleted,
		Details:      map[string]any{"reason": ReasonWorkflowDeleted},
	}, now)
	return nil
}

// guardLiveLocked reports ErrWorkflowDeleted after failing the run when the
// workflow is missing or tombstoned. The caller holds m.mu. A live row runs
// the row-lock hook and returns nil.
func (m *Memory) guardLiveLocked(ctx context.Context, scope isolation.Scope, now time.Time, workflowID, executionID string) error {
	if _, ok := m.liveLocked(scope, workflowID); ok {
		runWorkflowRowLockHook(ctx)
		return nil
	}
	if executionID != "" {
		if err := m.stopExecutionLocked(scope, now, executionID); err != nil {
			return err
		}
	}
	return ErrWorkflowDeleted
}

func (m *Memory) stopExecutionLocked(scope isolation.Scope, now time.Time, executionID string) error {
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return ErrNotFound
	}
	if isTerminalExecution(exec.record.Status) && exec.record.Status != ExecutionPinned {
		return nil
	}
	errBody := workflowDeletedStepError()
	for i := range exec.jobs {
		if jobIsOpen(exec.jobs[i].Status) {
			exec.jobs[i].Status = JobFailed
			exec.jobs[i].UpdatedAt = now
		}
	}
	for i := range exec.steps {
		switch exec.steps[i].Status {
		case ExecutionPending, ExecutionQueued, ExecutionRunning, ExecutionWaiting:
			exec.steps[i].Error = errBody
			applyStepStatus(&exec.steps[i], ExecutionFailed, now)
		}
	}
	applyExecutionStatus(&exec.record, ExecutionFailed, now)
	m.executions[executionID] = exec
	m.appendAuditLocked(scope, AuditWrite{
		Action:       "execution.stop",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonWorkflowDeleted,
		Details:      map[string]any{"reason": ReasonWorkflowDeleted},
	}, now)
	return nil
}

func (m *Memory) AbandonIfWorkflowDeleted(ctx context.Context, scope isolation.Scope, now time.Time, executionID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return ErrNotFound
	}
	return m.guardLiveLocked(ctx, scope, now, exec.record.WorkflowID, executionID)
}
