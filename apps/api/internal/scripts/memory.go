package scripts

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

type memArtifact struct {
	workspaceID string
	record      Artifact
}

type memPin struct {
	workspaceID string
	pin         VersionPin
}

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu        sync.Mutex
	artifacts map[string]memArtifact
	pins      []memPin
}

// NewMemory returns an empty in-process script artifact store.
func NewMemory() *Memory {
	return &Memory{artifacts: map[string]memArtifact{}}
}

func (m *Memory) Put(_ context.Context, scope isolation.Scope, art Artifact) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if art.Status != "" && art.Status != StatusPublished {
		return Artifact{}, ErrMutable
	}
	if art.ScanStatus != ScanClean || strings.TrimSpace(art.Signature) == "" {
		return Artifact{}, ErrUnscanned
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, row := range m.artifacts {
		if row.workspaceID == scope.WorkspaceID() && row.record.Digest == art.Digest {
			if row.record.Status != StatusPublished {
				return Artifact{}, ErrMutable
			}
			return cloneArtifact(row.record), nil
		}
	}
	if art.ID == "" {
		art.ID = newID()
	}
	if art.CreatedAt.IsZero() {
		art.CreatedAt = time.Now().UTC()
	}
	art.Status = StatusPublished
	art.CreatedBy = scope.ActorID()
	m.artifacts[art.ID] = memArtifact{workspaceID: scope.WorkspaceID(), record: cloneArtifact(art)}
	return cloneArtifact(art), nil
}

// PutDraft inserts a mutable row for negative tests only.
func (m *Memory) PutDraft(_ context.Context, scope isolation.Scope, art Artifact) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if art.ID == "" {
		art.ID = newID()
	}
	if art.CreatedAt.IsZero() {
		art.CreatedAt = time.Now().UTC()
	}
	if art.Status == "" {
		art.Status = StatusDraft
	}
	art.CreatedBy = scope.ActorID()
	m.artifacts[art.ID] = memArtifact{workspaceID: scope.WorkspaceID(), record: cloneArtifact(art)}
	return cloneArtifact(art), nil
}

func (m *Memory) Get(_ context.Context, scope isolation.Scope, id string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Artifact{}, ErrNotFound
	}
	return cloneArtifact(row.record), nil
}

func (m *Memory) GetByDigest(_ context.Context, scope isolation.Scope, digest string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, row := range m.artifacts {
		if row.workspaceID == scope.WorkspaceID() && row.record.Digest == digest {
			return cloneArtifact(row.record), nil
		}
	}
	return Artifact{}, ErrNotFound
}

func (m *Memory) BindVersion(_ context.Context, scope isolation.Scope, workflowVersionID string, pins []VersionPin) ([]VersionPin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(workflowVersionID) {
		return nil, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, existing := range m.pins {
		if existing.workspaceID == scope.WorkspaceID() && existing.pin.WorkflowVersionID == workflowVersionID {
			return nil, ErrImmutable
		}
	}
	out := make([]VersionPin, 0, len(pins))
	for _, pin := range pins {
		pin.WorkflowVersionID = workflowVersionID
		if pin.NodeID == "" || pin.ArtifactID == "" || pin.Digest == "" {
			return nil, ErrInvalid
		}
		row, ok := m.artifacts[pin.ArtifactID]
		if !ok || row.workspaceID != scope.WorkspaceID() {
			return nil, ErrNotFound
		}
		m.pins = append(m.pins, memPin{workspaceID: scope.WorkspaceID(), pin: pin})
		out = append(out, pin)
	}
	if out == nil {
		out = []VersionPin{}
	}
	return out, nil
}

// Corrupt mutates a stored artifact for negative execute tests only.
func (m *Memory) Corrupt(id string, fn func(*Artifact)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[id]
	if !ok || fn == nil {
		return
	}
	fn(&row.record)
	m.artifacts[id] = row
}

func (m *Memory) ListVersionPins(_ context.Context, scope isolation.Scope, workflowVersionID string) ([]VersionPin, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []VersionPin
	for _, row := range m.pins {
		if row.workspaceID == scope.WorkspaceID() && row.pin.WorkflowVersionID == workflowVersionID {
			out = append(out, row.pin)
		}
	}
	if out == nil {
		out = []VersionPin{}
	}
	return out, nil
}

func cloneArtifact(in Artifact) Artifact {
	out := in
	if in.Metadata != nil {
		cp := make(map[string]any, len(in.Metadata))
		for k, v := range in.Metadata {
			cp[k] = v
		}
		out.Metadata = cp
	}
	if in.Package != nil {
		out.Package = append([]byte(nil), in.Package...)
	}
	if in.RevokedAt != nil {
		t := *in.RevokedAt
		out.RevokedAt = &t
	}
	out.RevokedBy = in.RevokedBy
	return out
}

func (m *Memory) Revoke(_ context.Context, scope isolation.Scope, id string, now time.Time, actorID, reason string) (Artifact, error) {
	if scope.Zero() {
		return Artifact{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Artifact{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.artifacts[id]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return Artifact{}, ErrNotFound
	}
	if row.record.RevokedAt == nil || row.record.RevokedAt.IsZero() {
		t := now
		row.record.RevokedAt = &t
		if actorID != "" {
			row.record.RevokedBy = actorID
		}
		if row.record.Metadata == nil {
			row.record.Metadata = map[string]any{}
		}
		if reason != "" {
			row.record.Metadata["revokeReason"] = reason
		}
		if actorID != "" {
			row.record.Metadata["revokedBy"] = actorID
		}
		m.artifacts[id] = row
	}
	return cloneArtifact(row.record), nil
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
