package wfstore

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

var _ ItemStore = (*Memory)(nil)

// PutStepItems mirrors Postgres: caps checked before any write, the run
// budget checked and updated under the store mutex, items, summary, and
// the counts-only audit committed together or not at all.
func (m *Memory) PutStepItems(_ context.Context, scope isolation.Scope, in PutStepItemsInput) (PutStepItemsResult, error) {
	if scope.Zero() {
		return PutStepItemsResult{}, ErrNoScope
	}
	prep, err := prepareItems(in)
	if err != nil {
		return PutStepItemsResult{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[in.ExecutionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return PutStepItemsResult{}, ErrNotFound
	}
	si := -1
	for i := range exec.steps {
		if exec.steps[i].ID == in.StepID {
			si = i
			break
		}
	}
	if si < 0 {
		return PutStepItemsResult{}, ErrNotFound
	}
	if exec.itemsWritten[in.StepID] {
		return PutStepItemsResult{}, ErrConflict
	}
	merged, err := buildItemsOutput(exec.steps[si].Output, prep)
	if err != nil {
		return PutStepItemsResult{}, err
	}
	if exec.itemBytes+prep.bytes > workflow.MaxRunItemBytes {
		return PutStepItemsResult{}, &ItemCapError{Code: ItemCodeRunBudgetExceeded}
	}
	rows := map[string][]StepItem{}
	for _, p := range prep.ports {
		list := make([]StepItem, 0, len(p.items))
		for _, it := range p.items {
			list = append(list, StepItem{Idx: it.idx, Item: cloneObject(it.value), Lineage: cloneObject(it.lineage)})
		}
		rows[p.port] = list
	}
	step := cloneStep(exec.steps[si])
	if exec.items == nil {
		exec.items = map[string]map[string][]StepItem{}
	}
	exec.items[in.StepID] = rows
	exec.itemBytes += prep.bytes
	if exec.itemsWritten == nil {
		exec.itemsWritten = map[string]bool{}
	}
	exec.itemsWritten[in.StepID] = true
	exec.steps[si].Output = merged
	m.executions[in.ExecutionID] = exec
	m.audits = append(m.audits, memAudit{workspaceID: scope.WorkspaceID(), record: newAudit(scope, itemsAudit(step, prep), time.Now().UTC())})
	return PutStepItemsResult{Count: prep.count, Bytes: prep.bytes}, nil
}

// ListStepItems returns one page of redacted items for the scope's
// workspace. A step in another workspace is ErrNotFound.
func (m *Memory) ListStepItems(_ context.Context, scope isolation.Scope, q StepItemsQuery) (StepItemsPage, error) {
	if scope.Zero() {
		return StepItemsPage{}, ErrNoScope
	}
	q, err := normalizeItemsQuery(q)
	if err != nil {
		return StepItemsPage{}, err
	}
	if !authz.ValidUUID(q.ExecutionID) {
		return StepItemsPage{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[q.ExecutionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return StepItemsPage{}, ErrNotFound
	}
	var step *ExecutionStep
	for i := range exec.steps {
		if exec.steps[i].ID == q.StepID {
			step = &exec.steps[i]
			break
		}
	}
	if step == nil {
		return StepItemsPage{}, ErrNotFound
	}
	total, ok := itemsSummaryCount(step.Output, q.Port)
	if !ok {
		return singleItemPage(cloneStep(*step), q), nil
	}
	page := StepItemsPage{Items: []StepItem{}, Total: total, Next: -1}
	for _, it := range exec.items[q.StepID][q.Port] {
		if it.Idx <= q.AfterIdx {
			continue
		}
		if len(page.Items) == q.Limit {
			page.Next = page.Items[len(page.Items)-1].Idx
			break
		}
		page.Items = append(page.Items, StepItem{Idx: it.Idx, Item: cloneObject(it.Item), Lineage: cloneObject(it.Lineage)})
	}
	return page, nil
}

// markMemoryItemsIndeterminate flips in-flight unknown items to
// indeterminate on lease loss. Succeeded rows stay succeeded.
func markMemoryItemsIndeterminate(exec *memExecution, stepID string) {
	if exec == nil || exec.items == nil {
		return
	}
	ports := exec.items[stepID]
	for port, list := range ports {
		for i := range list {
			if list[i].Status == ItemStatusUnknown {
				list[i].Status = ItemStatusIndeterminate
			}
		}
		ports[port] = list
	}
}
