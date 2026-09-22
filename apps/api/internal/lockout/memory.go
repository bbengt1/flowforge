package lockout

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process store. It survives only as long as the value
// is reused, which is how tests simulate a process restart against a
// durable backend. Production uses Postgres.
type Memory struct {
	mu   sync.Mutex
	rows map[string]State
}

// NewMemory returns an empty store.
func NewMemory() *Memory {
	return &Memory{rows: map[string]State{}}
}

func (m *Memory) NoteFailure(_ context.Context, userID string, max int, now time.Time) (State, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || max < MinMaxFailures {
		return State{}, ErrInvalid
	}
	now = now.UTC()
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.rows[userID]
	st.UserID = userID
	if st.Failed < max {
		st.Failed++
	}
	if st.Failed >= max && st.LockedAt == nil {
		t := now
		st.LockedAt = &t
	}
	st.UpdatedAt = now
	m.rows[userID] = st
	return st, nil
}

func (m *Memory) Get(_ context.Context, userID string) (State, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return State{}, ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	st, ok := m.rows[userID]
	if !ok {
		return State{UserID: userID}, nil
	}
	return st, nil
}

func (m *Memory) Clear(ctx context.Context, userID string) error {
	return m.Unlock(ctx, userID)
}

func (m *Memory) Unlock(_ context.Context, userID string) error {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.rows, userID)
	return nil
}
