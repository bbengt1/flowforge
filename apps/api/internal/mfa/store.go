package mfa

import (
	"context"
	"time"
)

// Factor is a stored TOTP enrollment. Secret ciphertext is never JSON.
type Factor struct {
	UserID     string
	Ciphertext []byte
	Confirmed  bool
	LastStep   int64
}

// Store persists encrypted TOTP factors. Identity substrate: no workspace RLS.
type Store interface {
	// PutPending stores a new secret. A confirmed factor returns ErrConflict.
	PutPending(ctx context.Context, userID string, ciphertext []byte, now time.Time) error
	// Get returns the factor. ErrNotFound when the user has none.
	Get(ctx context.Context, userID string) (Factor, error)
	// Accept records a successful code. confirm marks the factor enrolled.
	Accept(ctx context.Context, userID string, step int64, confirm bool, now time.Time) error
}
