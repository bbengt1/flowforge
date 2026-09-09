package isolation

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu      sync.Mutex
	records map[string]Record // id -> record
	links   []Link
}

// NewMemory returns an empty isolation store.
func NewMemory() *Memory {
	return &Memory{records: map[string]Record{}}
}

func (m *Memory) Create(_ context.Context, scope Scope, rec Record) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if !ValidKind(rec.Kind) || strings.TrimSpace(rec.Name) == "" || len(rec.Name) > 200 {
		return Record{}, ErrInvalid
	}
	now := time.Now().UTC()
	out := Record{
		WorkspaceID: scope.WorkspaceID(),
		ID:          newID(),
		Kind:        rec.Kind,
		Name:        strings.TrimSpace(rec.Name),
		Metadata:    StampTenancy(rec.Metadata, scope),
		CreatedBy:   scope.ActorID(),
		CreatedAt:   now,
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.records[out.ID] = out
	return out, nil
}

func (m *Memory) Get(_ context.Context, scope Scope, id string) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.records[id]
	if !ok || rec.WorkspaceID != scope.WorkspaceID() {
		return Record{}, ErrNotFound
	}
	return rec, nil
}

func (m *Memory) List(_ context.Context, scope Scope, kind string) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if kind != "" && !ValidKind(kind) {
		return nil, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Record
	for _, rec := range m.records {
		if rec.WorkspaceID != scope.WorkspaceID() {
			continue
		}
		if kind != "" && rec.Kind != kind {
			continue
		}
		out = append(out, rec)
	}
	if out == nil {
		out = []Record{}
	}
	return out, nil
}

func (m *Memory) Link(_ context.Context, scope Scope, parentID, kind string) (Link, error) {
	if scope.Zero() {
		return Link{}, ErrNoScope
	}
	if !ValidKind(kind) {
		return Link{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	parent, ok := m.records[parentID]
	if !ok || parent.WorkspaceID != scope.WorkspaceID() {
		return Link{}, ErrNotFound
	}
	link := Link{
		WorkspaceID: scope.WorkspaceID(),
		ID:          newID(),
		ParentID:    parent.ID,
		Kind:        kind,
		CreatedAt:   time.Now().UTC(),
	}
	m.links = append(m.links, link)
	return link, nil
}

func (m *Memory) UseCredential(ctx context.Context, scope Scope, id string) error {
	rec, err := m.Get(ctx, scope, id)
	if err != nil {
		return err
	}
	if rec.Kind != KindCredential {
		return ErrNotFound
	}
	_, err = m.Create(ctx, scope, Record{Kind: KindAudit, Name: "credential.use", Metadata: map[string]any{"resource_id": id}})
	return err
}

func (m *Memory) Subscribe(ctx context.Context, scope Scope, channelID string) error {
	rec, err := m.Get(ctx, scope, channelID)
	if err != nil {
		return err
	}
	if rec.Kind != KindRealtime {
		return ErrNotFound
	}
	return nil
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
