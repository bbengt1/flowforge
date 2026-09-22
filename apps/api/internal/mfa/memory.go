package mfa

import (
	"context"
	"sync"
	"time"
)

type row struct {
	ciphertext []byte
	confirmed  bool
	lastStep   int64
}

// Memory is an in-process factor store.
type Memory struct {
	mu   sync.Mutex
	rows map[string]row
}

// NewMemory returns an empty store.
func NewMemory() *Memory {
	return &Memory{rows: map[string]row{}}
}

// PutPending replaces an unconfirmed secret. Confirmed factors conflict.
func (m *Memory) PutPending(_ context.Context, userID string, ciphertext []byte, _ time.Time) error {
	if userID == "" || len(ciphertext) == 0 {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if cur, ok := m.rows[userID]; ok && cur.confirmed {
		return ErrConflict
	}
	m.rows[userID] = row{ciphertext: append([]byte(nil), ciphertext...)}
	return nil
}

// Get returns the factor.
func (m *Memory) Get(_ context.Context, userID string) (Factor, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.rows[userID]
	if !ok {
		return Factor{}, ErrNotFound
	}
	return Factor{
		UserID:     userID,
		Ciphertext: append([]byte(nil), cur.ciphertext...),
		Confirmed:  cur.confirmed,
		LastStep:   cur.lastStep,
	}, nil
}

// Accept updates the last accepted step and optionally confirms enrollment.
func (m *Memory) Accept(_ context.Context, userID string, step int64, confirm bool, _ time.Time) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	cur, ok := m.rows[userID]
	if !ok {
		return ErrNotFound
	}
	if step <= cur.lastStep {
		return ErrRejected
	}
	cur.lastStep = step
	if confirm {
		cur.confirmed = true
	}
	m.rows[userID] = cur
	return nil
}
