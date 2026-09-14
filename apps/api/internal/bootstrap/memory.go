package bootstrap

import (
	"context"
	"sync"
	"time"
)

// Memory is an in-process Store used by HTTP unit tests.
type Memory struct {
	mu    sync.Mutex
	state State
}

// NewMemory returns an incomplete singleton.
func NewMemory() *Memory {
	return &Memory{
		state: State{
			TLSMode:   TLSModeNone,
			UpdatedAt: time.Now().UTC(),
		},
	}
}

// Get returns a copy of the singleton.
func (m *Memory) Get(_ context.Context) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return copyState(m.state), nil
}

// SetStep updates one readiness flag. It does not mark complete.
func (m *Memory) SetStep(_ context.Context, step string, ready bool) error {
	if !validStep(step) {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	applyStep(&m.state, step, ready)
	m.state.UpdatedAt = time.Now().UTC()
	return nil
}

// SetPublicURL stores the server-only URL and marks publicUrl ready.
func (m *Memory) SetPublicURL(_ context.Context, publicBaseURL string) error {
	normalized, err := NormalizePublicBaseURL(publicBaseURL)
	if err != nil {
		return err
	}
	if normalized == "" {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.PublicBaseURL = normalized
	m.state.PublicURLReady = true
	m.state.UpdatedAt = time.Now().UTC()
	return nil
}

// SetTLS updates TLS readiness and status-only mode.
func (m *Memory) SetTLS(_ context.Context, ready bool, mode string) error {
	normalized, err := NormalizeTLSMode(mode)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.TLSReady = ready
	m.state.TLSMode = normalized
	m.state.UpdatedAt = time.Now().UTC()
	return nil
}

// MarkComplete sets the overall gate. Wizard must not reappear after this.
func (m *Memory) MarkComplete(_ context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	markComplete(&m.state, false)
	return nil
}

// MarkSeedSkip marks trusted-dev / compose localseed complete (admin + URL).
func (m *Memory) MarkSeedSkip(_ context.Context, skip SeedSkip) error {
	url, err := ResolveSeedPublicURL(skip.PublicBaseURL)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.state.PersistenceReady = true
	m.state.FirstAdminReady = true
	m.state.PublicURLReady = true
	if m.state.PublicBaseURL == "" {
		m.state.PublicBaseURL = url
	}
	markComplete(&m.state, true)
	return nil
}

func markComplete(s *State, skipped bool) {
	now := time.Now().UTC()
	s.Complete = true
	if skipped {
		s.Skipped = true
	}
	if s.CompletedAt == nil {
		s.CompletedAt = &now
	}
	s.UpdatedAt = now
}

func applyStep(s *State, step string, ready bool) {
	switch step {
	case StepPersistence:
		s.PersistenceReady = ready
	case StepFirstAdmin:
		s.FirstAdminReady = ready
	case StepPublicURL:
		s.PublicURLReady = ready
	case StepTLS:
		s.TLSReady = ready
	}
}

func copyState(s State) State {
	out := s
	if s.CompletedAt != nil {
		t := *s.CompletedAt
		out.CompletedAt = &t
	}
	return out
}
