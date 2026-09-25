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
	for _, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() || exec.record.WorkflowID != id {
			continue
		}
		if executionBlocksDelete(exec.record.Status) {
			return DeleteResult{}, ErrActiveExecutions
		}
	}
	published := row.record.Status == StatusPublished
	now := time.Now().UTC()
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
