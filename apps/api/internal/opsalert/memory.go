package opsalert

import (
	"context"
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

type memAlert struct {
	workspaceID string
	record      Alert
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu     sync.Mutex
	alerts []memAlert
}

// NewMemory returns an empty alert store.
func NewMemory() *Memory {
	return &Memory{}
}

// Emit sanitizes and appends an alert.
func (m *Memory) Emit(_ context.Context, scope isolation.Scope, in Signal) (Alert, error) {
	if scope.Zero() {
		return Alert{}, ErrNoScope
	}
	alert, err := prepareAlert(scope, in, time.Now().UTC())
	if err != nil {
		return Alert{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.alerts = append(m.alerts, memAlert{workspaceID: scope.WorkspaceID(), record: cloneAlert(alert)})
	return cloneAlert(alert), nil
}

// List returns newest-first alerts for the scope.
func (m *Memory) List(_ context.Context, scope isolation.Scope, filter ListFilter) ([]Alert, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []Alert{}
	kind := strings.TrimSpace(filter.Kind)
	status := strings.TrimSpace(filter.Status)
	resourceType := strings.TrimSpace(filter.ResourceType)
	resourceID := sanitizeID(filter.ResourceID)
	if filter.ResourceID != "" && resourceID == "" {
		return nil, ErrNotFound
	}
	for _, row := range m.alerts {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if kind != "" && row.record.Kind != kind {
			continue
		}
		if resourceType != "" && row.record.ResourceType != resourceType {
			continue
		}
		if resourceID != "" && row.record.ResourceID != resourceID {
			continue
		}
		if status == "open" && row.record.AcknowledgedAt != nil {
			continue
		}
		if status == "acked" && row.record.AcknowledgedAt == nil {
			continue
		}
		out = append(out, cloneAlert(row.record))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].OccurredAt.After(out[j].OccurredAt)
	})
	limit := listLimit(filter.Limit)
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// Get returns one alert or ErrNotFound.
func (m *Memory) Get(_ context.Context, scope isolation.Scope, id string) (Alert, error) {
	if scope.Zero() {
		return Alert{}, ErrNoScope
	}
	id = sanitizeID(id)
	if id == "" {
		return Alert{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, row := range m.alerts {
		if row.workspaceID == scope.WorkspaceID() && row.record.ID == id {
			return cloneAlert(row.record), nil
		}
	}
	return Alert{}, ErrNotFound
}

// Ack marks an alert acknowledged. Repeat acks are idempotent.
func (m *Memory) Ack(_ context.Context, scope isolation.Scope, id string) (Alert, error) {
	if scope.Zero() {
		return Alert{}, ErrNoScope
	}
	id = sanitizeID(id)
	if id == "" {
		return Alert{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for i, row := range m.alerts {
		if row.workspaceID != scope.WorkspaceID() || row.record.ID != id {
			continue
		}
		if row.record.AcknowledgedAt == nil {
			now := time.Now().UTC()
			row.record.AcknowledgedAt = &now
			row.record.AcknowledgedBy = scope.ActorID()
			m.alerts[i] = row
		}
		return cloneAlert(row.record), nil
	}
	return Alert{}, ErrNotFound
}

func prepareAlert(scope isolation.Scope, in Signal, now time.Time) (Alert, error) {
	in = Sanitize(in)
	if !KnownKind(in.Kind) || in.Outcome == "" || in.Code == "" {
		return Alert{}, ErrInvalid
	}
	if in.ActorID == "" {
		in.ActorID = sanitizeID(scope.ActorID())
	}
	alert := AlertFromSignal(in, now)
	alert.ID = newID()
	if alert.Details == nil {
		alert.Details = map[string]any{}
	}
	return alert, nil
}

func cloneAlert(in Alert) Alert {
	out := in
	if in.AcknowledgedAt != nil {
		t := *in.AcknowledgedAt
		out.AcknowledgedAt = &t
	}
	if in.Details != nil {
		out.Details = map[string]any{}
		for k, v := range in.Details {
			out.Details[k] = v
		}
	}
	return out
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
