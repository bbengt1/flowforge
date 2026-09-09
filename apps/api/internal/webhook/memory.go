package webhook

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type memTrigger struct {
	workspaceID string
	record      Trigger
}

type memReplay struct {
	workspaceID string
	triggerID   string
	replayID    string
	expiresAt   time.Time
}

type memWindow struct {
	count     int
	inFlight  int
	windowKey int64
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu       sync.Mutex
	triggers map[string]memTrigger // id or public id
	byPublic map[string]string
	replays  []memReplay
	trigRate map[string]memWindow
	wsRate   map[string]memWindow
	trigFly  map[string]int
	wsFly    map[string]int
}

// NewMemory returns an empty webhook store.
func NewMemory() *Memory {
	return &Memory{
		triggers: map[string]memTrigger{},
		byPublic: map[string]string{},
		trigRate: map[string]memWindow{},
		wsRate:   map[string]memWindow{},
		trigFly:  map[string]int{},
		wsFly:    map[string]int{},
	}
}

func (m *Memory) Create(_ context.Context, scope isolation.Scope, in CreateInput) (Trigger, error) {
	trig, err := normalizeCreate(scope, in, time.Now().UTC())
	if err != nil {
		return Trigger{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.triggers[trig.ID] = memTrigger{workspaceID: scope.WorkspaceID(), record: trig}
	m.byPublic[trig.PublicID] = trig.ID
	return cloneTrigger(trig), nil
}

func (m *Memory) List(_ context.Context, scope isolation.Scope, workflowID string) ([]Trigger, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Trigger
	for _, row := range m.triggers {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if workflowID != "" && row.record.WorkflowID != workflowID {
			continue
		}
		out = append(out, cloneTrigger(row.record))
	}
	if out == nil {
		out = []Trigger{}
	}
	return out, nil
}

func (m *Memory) Get(_ context.Context, scope isolation.Scope, id string) (Trigger, error) {
	row, err := m.lookup(scope, id)
	if err != nil {
		return Trigger{}, err
	}
	return cloneTrigger(row.record), nil
}

func (m *Memory) Update(_ context.Context, scope isolation.Scope, id string, in UpdateInput) (Trigger, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Trigger{}, err
	}
	updated, err := applyUpdate(row.record, in, scope.ActorID(), time.Now().UTC())
	if err != nil {
		return Trigger{}, err
	}
	row.record = updated
	m.triggers[row.record.ID] = row
	return cloneTrigger(updated), nil
}

func (m *Memory) SetStatus(_ context.Context, scope isolation.Scope, id, status string) (Trigger, error) {
	status = strings.TrimSpace(status)
	if status != StatusEnabled && status != StatusDisabled {
		return Trigger{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return Trigger{}, err
	}
	row.record.Status = status
	row.record.UpdatedBy = scope.ActorID()
	row.record.UpdatedAt = time.Now().UTC()
	m.triggers[row.record.ID] = row
	return cloneTrigger(row.record), nil
}

func (m *Memory) Delete(_ context.Context, scope isolation.Scope, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, id)
	if err != nil {
		return err
	}
	delete(m.byPublic, row.record.PublicID)
	delete(m.triggers, row.record.ID)
	return nil
}

func (m *Memory) LookupPublic(_ context.Context, publicID string) (string, Trigger, error) {
	publicID = strings.TrimSpace(publicID)
	if !publicIDLooksValid(publicID) {
		return "", Trigger{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	id, ok := m.byPublic[publicID]
	if !ok {
		return "", Trigger{}, ErrNotFound
	}
	row, ok := m.triggers[id]
	if !ok {
		return "", Trigger{}, ErrNotFound
	}
	return row.workspaceID, cloneTrigger(row.record), nil
}

func (m *Memory) AcquireDelivery(_ context.Context, scope isolation.Scope, triggerID string, now time.Time, limits DeliveryLimits) error {
	if scope.Zero() {
		return ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, triggerID)
	if err != nil {
		return err
	}
	if row.record.Status != StatusEnabled {
		return ErrDisabled
	}
	now = now.UTC()
	m.purgeReplaysLocked(now)
	for _, r := range m.replays {
		if r.workspaceID == scope.WorkspaceID() && r.triggerID == row.record.ID && r.replayID == limits.ReplayID && r.expiresAt.After(now) {
			return ErrReplay
		}
	}
	window := now.Truncate(time.Minute).Unix()
	trigKey := scope.WorkspaceID() + ":" + row.record.ID
	wsKey := scope.WorkspaceID()
	trigWin := m.trigRate[trigKey]
	if trigWin.windowKey != window {
		trigWin = memWindow{windowKey: window}
	}
	wsWin := m.wsRate[wsKey]
	if wsWin.windowKey != window {
		wsWin = memWindow{windowKey: window}
	}
	if limits.RateLimitPerMinute > 0 && trigWin.count >= limits.RateLimitPerMinute {
		return ErrRateLimited
	}
	if limits.WorkspaceRatePerMinute > 0 && wsWin.count >= limits.WorkspaceRatePerMinute {
		return ErrRateLimited
	}
	if limits.MaxConcurrency > 0 && m.trigFly[trigKey] >= limits.MaxConcurrency {
		return ErrConcurrency
	}
	if limits.WorkspaceMaxConcurrency > 0 && m.wsFly[wsKey] >= limits.WorkspaceMaxConcurrency {
		return ErrConcurrency
	}
	retention := limits.ReplayRetention
	if retention <= 0 {
		retention = time.Duration(row.record.ReplayRetentionSeconds) * time.Second
	}
	m.replays = append(m.replays, memReplay{
		workspaceID: scope.WorkspaceID(),
		triggerID:   row.record.ID,
		replayID:    limits.ReplayID,
		expiresAt:   now.Add(retention),
	})
	trigWin.count++
	wsWin.count++
	m.trigRate[trigKey] = trigWin
	m.wsRate[wsKey] = wsWin
	m.trigFly[trigKey]++
	m.wsFly[wsKey]++
	return nil
}

func (m *Memory) ReleaseDelivery(_ context.Context, scope isolation.Scope, triggerID string, _ time.Time) {
	if scope.Zero() {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, err := m.lookupLocked(scope, triggerID)
	if err != nil {
		return
	}
	trigKey := scope.WorkspaceID() + ":" + row.record.ID
	wsKey := scope.WorkspaceID()
	if m.trigFly[trigKey] > 0 {
		m.trigFly[trigKey]--
	}
	if m.wsFly[wsKey] > 0 {
		m.wsFly[wsKey]--
	}
}

func (m *Memory) FindCredentialRefs(_ context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(credentialID) {
		return []wfstore.CredentialRef{}, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []wfstore.CredentialRef
	for _, row := range m.triggers {
		if row.workspaceID != scope.WorkspaceID() || row.record.SecretCredentialID != credentialID {
			continue
		}
		out = append(out, wfstore.CredentialRef{
			Kind:         wfstore.CredentialRefTrigger,
			WorkflowID:   row.record.WorkflowID,
			WorkflowSlug: row.record.PublicID,
			WorkflowName: "webhook",
			VersionID:    row.record.WorkflowVersionID,
		})
	}
	if out == nil {
		out = []wfstore.CredentialRef{}
	}
	return out, nil
}

func (m *Memory) lookup(scope isolation.Scope, id string) (memTrigger, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lookupLocked(scope, id)
}

func (m *Memory) lookupLocked(scope isolation.Scope, id string) (memTrigger, error) {
	if scope.Zero() {
		return memTrigger{}, ErrNoScope
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return memTrigger{}, ErrNotFound
	}
	if resolved, ok := m.byPublic[id]; ok {
		id = resolved
	}
	row, ok := m.triggers[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return memTrigger{}, ErrNotFound
	}
	return row, nil
}

func (m *Memory) purgeReplaysLocked(now time.Time) {
	kept := m.replays[:0]
	for _, r := range m.replays {
		if r.expiresAt.After(now) {
			kept = append(kept, r)
		}
	}
	m.replays = kept
}
