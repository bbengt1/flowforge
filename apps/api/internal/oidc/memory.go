package oidc

import (
	"context"
	"sync"
	"time"
)

// Memory is an in-process transaction store for tests and non-pool boots.
type Memory struct {
	mu   sync.Mutex
	by   map[string]Tx
	used map[string]struct{}
}

// NewMemory returns an empty store.
func NewMemory() *Memory {
	return &Memory{by: map[string]Tx{}, used: map[string]struct{}{}}
}

// Put stores a transaction. A duplicate state hash is rejected.
func (m *Memory) Put(_ context.Context, tx Tx) error {
	if len(tx.StateHash) != sha256Len || tx.Nonce == "" || len(tx.VerifierBlob) == 0 {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(tx.StateHash)
	if _, ok := m.by[key]; ok {
		return ErrInvalid
	}
	if _, ok := m.used[key]; ok {
		return ErrInvalid
	}
	m.by[key] = tx
	return nil
}

// Consume returns a live transaction once.
func (m *Memory) Consume(_ context.Context, stateHash []byte, now time.Time) (Tx, error) {
	if len(stateHash) != sha256Len {
		return Tx{}, ErrRejected
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(stateHash)
	if _, ok := m.used[key]; ok {
		return Tx{}, ErrRejected
	}
	tx, ok := m.by[key]
	if !ok || !tx.ExpiresAt.After(now.UTC()) {
		delete(m.by, key)
		return Tx{}, ErrRejected
	}
	delete(m.by, key)
	m.used[key] = struct{}{}
	return tx, nil
}

const sha256Len = 32
