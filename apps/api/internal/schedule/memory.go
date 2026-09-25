package schedule

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
)

type memRow struct {
	workspaceID string
	record      Record
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu   sync.Mutex
	rows map[string]memRow
}

// NewMemory returns an empty schedule store.
func NewMemory() *Memory {
	return &Memory{rows: map[string]memRow{}}
}

func (m *Memory) Create(_ context.Context, scope isolation.Scope, now time.Time, in CreateInput) (Record, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	rec, err := normalizeCreate(scope, in, now)
	if err != nil {
		return Record{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.rows[rec.ID] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	return cloneRecord(rec), nil
}

func (m *Memory) List(ctx context.Context, scope isolation.Scope, workflowID string) ([]Record, error) {
	items, _, err := m.ListPage(ctx, scope, workflowID, page.Query{})
	return items, err
}

func (m *Memory) ListPage(_ context.Context, scope isolation.Scope, workflowID string, q page.Query) ([]Record, string, error) {
	if scope.Zero() {
		return nil, "", ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Record
	for _, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if workflowID != "" && row.record.WorkflowID != workflowID {
			continue
		}
		out = append(out, cloneRecord(row.record))
	}
	if !q.Bound {
		sort.Slice(out, func(i, j int) bool {
			return out[i].CreatedAt.After(out[j].CreatedAt)
		})
		if out == nil {
			out = []Record{}
		}
		return out, "", nil
	}
	return page.Select(page.ColSchedule, q, true, out, func(rec Record) page.Key {
		return page.Key{K: page.TimeKey(rec.CreatedAt), ID: rec.ID}
	}, func(rec Record) bool {
		return page.Hit(q.Q, rec.Cron, rec.Interval, rec.Timezone, rec.TriggerID, rec.Status)
	})
}

func (m *Memory) Get(_ context.Context, scope isolation.Scope, id string) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Record{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Record{}, ErrNotFound
	}
	return cloneRecord(row.record), nil
}

func (m *Memory) Update(_ context.Context, scope isolation.Scope, now time.Time, id string, in UpdateInput) (Record, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Record{}, err
	}
	rec, err := applyUpdate(row.record, in, scope.ActorID(), now)
	if err != nil {
		return Record{}, err
	}
	m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	return cloneRecord(rec), nil
}

func (m *Memory) SetStatus(_ context.Context, scope isolation.Scope, now time.Time, id, status string) (Record, error) {
	status = strings.TrimSpace(status)
	if status != StatusEnabled && status != StatusDisabled {
		return Record{}, ErrInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Record{}, err
	}
	rec := row.record
	rec.Status = status
	rec.UpdatedBy = scope.ActorID()
	rec.UpdatedAt = now.UTC()
	if status == StatusEnabled {
		next, err := NextAfter(rec, now.UTC())
		if err != nil {
			return Record{}, err
		}
		rec.NextFireAt = next
		rec.LastError = ""
	}
	m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	return cloneRecord(rec), nil
}

func (m *Memory) DisableForWorkflow(_ context.Context, scope isolation.Scope, now time.Time, workflowID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() || row.record.WorkflowID != workflowID {
			continue
		}
		if row.record.Status == StatusDisabled {
			continue
		}
		row.record.Status = StatusDisabled
		row.record.UpdatedAt = now
		m.rows[id] = row
	}
	return nil
}

func (m *Memory) Delete(_ context.Context, scope isolation.Scope, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err := m.lookupLocked(scope, id); err != nil {
		return err
	}
	delete(m.rows, id)
	return nil
}

func (m *Memory) ListDue(_ context.Context, scope isolation.Scope, now time.Time) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Record
	for _, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if row.record.Status != StatusEnabled {
			continue
		}
		if row.record.NextFireAt.After(now) {
			continue
		}
		out = append(out, cloneRecord(row.record))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].NextFireAt.Before(out[j].NextFireAt)
	})
	if out == nil {
		out = []Record{}
	}
	return out, nil
}

func (m *Memory) RecordFire(_ context.Context, scope isolation.Scope, now time.Time, id string, in FireUpdate) (Record, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Record{}, err
	}
	rec := row.record
	if !in.NextFireAt.IsZero() {
		rec.NextFireAt = in.NextFireAt.UTC()
	}
	if in.LastFiredAt != nil {
		t := in.LastFiredAt.UTC()
		rec.LastFiredAt = &t
	}
	if strings.TrimSpace(in.LastExecutionID) != "" {
		rec.LastExecutionID = strings.TrimSpace(in.LastExecutionID)
	}
	errText := strings.TrimSpace(in.LastError)
	if len(errText) > MaxLastError {
		errText = errText[:MaxLastError]
	}
	rec.LastError = errText
	rec.UpdatedAt = now.UTC()
	m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	return cloneRecord(rec), nil
}

func (m *Memory) lookupLocked(scope isolation.Scope, id string) (memRow, error) {
	if scope.Zero() {
		return memRow{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return memRow{}, ErrNotFound
	}
	row, ok := m.rows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return memRow{}, ErrNotFound
	}
	return row, nil
}
