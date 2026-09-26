package approval

import (
	"context"
	"crypto/rand"
	"fmt"
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

// GateWaiting reports whether the latest flow.approval step for a node is
// still waiting. found is false when that step does not exist.
type GateWaiting func(executionID, nodeID string) (found, waiting bool)

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu     sync.Mutex
	rows   map[string]memRow
	events map[string][]Event
	gate   GateWaiting
}

// SetGateWaiting installs the check Decide uses before it accepts a decision.
// A nil func leaves decisions that have no gate view unchanged.
func (m *Memory) SetGateWaiting(fn GateWaiting) {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.gate = fn
}

// NewMemory returns an empty approval store.
func NewMemory() *Memory {
	return &Memory{rows: map[string]memRow{}, events: map[string][]Event{}}
}

func (m *Memory) Create(_ context.Context, scope isolation.Scope, in CreateInput) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	rec, err := recordFromCreate(scope, in, time.Now().UTC())
	if err != nil {
		return Record{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.supersedeLocked(scope, rec)
	for _, row := range m.rows {
		if row.workspaceID == scope.WorkspaceID() && row.record.BindingFingerprint == rec.BindingFingerprint &&
			(row.record.Status == StatusPending || row.record.Status == StatusApproved) {
			return cloneRecord(row.record), nil
		}
	}
	rec.ID = newID()
	m.rows[rec.ID] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	m.appendEventLocked(scope, rec.ID, EventCreated, scope.ActorID(), map[string]any{
		"operation": rec.Operation, "nodeId": rec.NodeID,
	})
	return cloneRecord(rec), nil
}

func (m *Memory) List(_ context.Context, scope isolation.Scope, filter Filter) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Record
	for _, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if !matchFilter(row.record, filter) {
			continue
		}
		if filter.Status == StatusPending && !row.record.ExpiresAt.After(time.Now().UTC()) {
			continue
		}
		out = append(out, cloneRecord(row.record))
	}
	if filter.Page.Bound {
		items, next, err := page.Select(page.ColApproval, filter.Page, true, out, func(rec Record) page.Key {
			return page.Key{K: page.TimeKey(rec.CreatedAt), ID: rec.ID}
		}, func(rec Record) bool {
			return page.Hit(filter.Page.Q, rec.NodeID, rec.NodeName, rec.Operation, rec.Status)
		})
		if err != nil {
			return nil, err
		}
		page.Remember(filter.Page, next)
		return items, nil
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if out == nil {
		out = []Record{}
	}
	return out, nil
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

func (m *Memory) Decide(_ context.Context, scope isolation.Scope, id string, in DecideInput) (Record, error) {
	decision, err := NormalizeDecision(in.Decision)
	if err != nil {
		return Record{}, err
	}
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Record{}, ErrNotFound
	}
	rec := row.record
	if rec.Status == StatusCanceled {
		return Record{}, ErrClosed
	}
	if rec.ExecutionID != "" && rec.NodeID != "" && m.gate != nil {
		found, waiting := m.gate(rec.ExecutionID, rec.NodeID)
		if found && !waiting {
			if rec.Status == StatusPending {
				rec.Status = StatusExpired
				rec.DecidedBy = ""
				rec.DecidedAt = nil
				rec.CloseReason = ""
				rec.UpdatedAt = now
				m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
				m.appendEventLocked(scope, rec.ID, EventExpired, "", map[string]any{"reason": "gate_expired"})
			}
			return Record{}, ErrClosed
		}
	}
	if scope.ActorID() != "" && rec.RequestedBy != "" && scope.ActorID() == rec.RequestedBy {
		return Record{}, ErrSelfApproval
	}
	status, reason := Freshness(rec, in.Heads, now)
	if status != rec.Status && (status == StatusExpired || status == StatusInvalidated) {
		rec = m.applyStatusLocked(scope, rec, status, reason, now)
		m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
		if status == StatusExpired {
			return cloneRecord(rec), ErrExpired
		}
		return cloneRecord(rec), ErrInvalidated
	}
	if rec.Status != StatusPending {
		return Record{}, ErrNotPending
	}
	rec.Status = decision
	rec.DecidedBy = scope.ActorID()
	rec.DecidedAt = &now
	rec.DecisionNote = strings.TrimSpace(in.Note)
	if len(rec.DecisionNote) > 2000 {
		return Record{}, ErrInvalid
	}
	rec.UpdatedAt = now
	m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	m.appendEventLocked(scope, rec.ID, decision, scope.ActorID(), map[string]any{"noteLength": len(rec.DecisionNote)})
	return cloneRecord(rec), nil
}

func (m *Memory) ClosePendingForExecution(_ context.Context, scope isolation.Scope, executionID, reason string, now time.Time) error {
	if scope.Zero() {
		return ErrNoScope
	}
	executionID = strings.TrimSpace(executionID)
	if !authz.ValidUUID(executionID) {
		return nil
	}
	if reason != ReasonRunCanceled && reason != ReasonWorkflowDeleted {
		return ErrInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() || row.record.ExecutionID != executionID || row.record.Status != StatusPending {
			continue
		}
		rec := row.record
		rec.Status = StatusCanceled
		rec.CloseReason = reason
		rec.DecidedBy = ""
		rec.DecidedAt = nil
		rec.UpdatedAt = now
		m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
		m.appendEventLocked(scope, rec.ID, EventCanceled, "", map[string]any{"reason": reason})
	}
	return nil
}

func (m *Memory) Refresh(_ context.Context, scope isolation.Scope, id string, heads CurrentHeads, now time.Time) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.rows[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Record{}, ErrNotFound
	}
	rec := row.record
	status, reason := Freshness(rec, heads, now)
	if status != rec.Status && (status == StatusExpired || status == StatusInvalidated) {
		rec = m.applyStatusLocked(scope, rec, status, reason, now)
		m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
	}
	return cloneRecord(rec), nil
}

func (m *Memory) InvalidateMatching(_ context.Context, scope isolation.Scope, in InvalidateInput) (int, error) {
	if scope.Zero() {
		return 0, ErrNoScope
	}
	now := in.Now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		reason = "binding changed"
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for id, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		rec := row.record
		if rec.Status != StatusPending && rec.Status != StatusApproved {
			continue
		}
		if !matchesInvalidate(rec, in) {
			continue
		}
		rec = m.applyStatusLocked(scope, rec, StatusInvalidated, reason, now)
		m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: rec}
		n++
	}
	return n, nil
}

func (m *Memory) Events(_ context.Context, scope isolation.Scope, id string) ([]Event, error) {
	if _, err := m.Get(context.Background(), scope, id); err != nil {
		return nil, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	src := m.events[id]
	out := make([]Event, len(src))
	copy(out, src)
	return out, nil
}

func (m *Memory) applyStatusLocked(scope isolation.Scope, rec Record, status, reason string, now time.Time) Record {
	rec.Status = status
	rec.UpdatedAt = now
	m.appendEventLocked(scope, rec.ID, status, scope.ActorID(), map[string]any{"reason": reason})
	return rec
}

func (m *Memory) supersedeLocked(scope isolation.Scope, rec Record) {
	if strings.TrimSpace(rec.ExecutionID) == "" || strings.TrimSpace(rec.NodeID) == "" {
		return
	}
	now := time.Now().UTC()
	for id, row := range m.rows {
		if row.workspaceID != scope.WorkspaceID() {
			continue
		}
		if row.record.ExecutionID != rec.ExecutionID || row.record.NodeID != rec.NodeID {
			continue
		}
		if row.record.Status != StatusPending || row.record.BindingFingerprint == rec.BindingFingerprint {
			continue
		}
		updated := row.record
		updated.Status = StatusInvalidated
		updated.UpdatedAt = now
		m.rows[id] = memRow{workspaceID: scope.WorkspaceID(), record: updated}
		m.appendEventLocked(scope, updated.ID, EventInvalidated, "", map[string]any{"reason": "approver_binding_replaced"})
	}
}

func (m *Memory) appendEventLocked(scope isolation.Scope, approvalID, eventType, actor string, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	m.events[approvalID] = append(m.events[approvalID], Event{
		ID:         newID(),
		ApprovalID: approvalID,
		EventType:  eventType,
		ActorID:    actor,
		Details:    details,
		OccurredAt: time.Now().UTC(),
	})
}

func recordFromCreate(scope isolation.Scope, in CreateInput, now time.Time) (Record, error) {
	if !authz.ValidUUID(in.WorkflowID) || !authz.ValidUUID(in.WorkflowVersionID) {
		return Record{}, ErrInvalid
	}
	req := in.Requirement
	if strings.TrimSpace(req.NodeID) == "" || strings.TrimSpace(req.Operation) == "" {
		return Record{}, ErrInvalid
	}
	if req.ExpiresAt.IsZero() {
		return Record{}, ErrInvalid
	}
	role := strings.TrimSpace(req.ApproverRole)
	if role == "" {
		role = "approver"
	}
	fp := BindingFingerprint(scope.WorkspaceID(), in.WorkflowVersionID, in.WorkflowDigest, req.TargetVersionID, req.PolicyVersionID, req.PolicyDigest, req.Operation, req.NodeID, role, in.ExecutionID)
	requestedBy := strings.TrimSpace(in.RequestedBy)
	if requestedBy == "" {
		requestedBy = scope.ActorID()
	}
	return Record{
		WorkflowID:         in.WorkflowID,
		WorkflowVersionID:  in.WorkflowVersionID,
		WorkflowDigest:     strings.TrimSpace(in.WorkflowDigest),
		ExecutionID:        strings.TrimSpace(in.ExecutionID),
		NodeID:             req.NodeID,
		NodeName:           req.NodeName,
		Operation:          req.Operation,
		TargetKind:         req.TargetKind,
		TargetID:           req.TargetID,
		TargetVersionID:    req.TargetVersionID,
		TargetDigest:       req.TargetDigest,
		PolicyResourceID:   req.PolicyResourceID,
		PolicyVersionID:    req.PolicyVersionID,
		PolicyDigest:       req.PolicyDigest,
		PolicyRevision:     req.PolicyRevision,
		BindingFingerprint: fp,
		ApproverRole:       role,
		Status:             StatusPending,
		ExpiresAt:          req.ExpiresAt.UTC(),
		RequestedBy:        requestedBy,
		CreatedAt:          now,
		UpdatedAt:          now,
	}, nil
}

func matchFilter(rec Record, filter Filter) bool {
	if filter.Status != "" && rec.Status != filter.Status {
		return false
	}
	if filter.WorkflowID != "" && rec.WorkflowID != filter.WorkflowID {
		return false
	}
	if filter.WorkflowVersionID != "" && rec.WorkflowVersionID != filter.WorkflowVersionID {
		return false
	}
	if filter.ExecutionID != "" && rec.ExecutionID != filter.ExecutionID {
		return false
	}
	return true
}

func matchesInvalidate(rec Record, in InvalidateInput) bool {
	if id := strings.TrimSpace(in.ResourceID); id != "" {
		return rec.TargetID == id || rec.PolicyResourceID == id
	}
	if id := strings.TrimSpace(in.TargetID); id != "" && rec.TargetID == id {
		return true
	}
	if id := strings.TrimSpace(in.PolicyResourceID); id != "" && rec.PolicyResourceID == id {
		return true
	}
	return false
}

func cloneRecord(in Record) Record {
	if in.DecidedAt != nil {
		t := *in.DecidedAt
		in.DecidedAt = &t
	}
	return in
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
