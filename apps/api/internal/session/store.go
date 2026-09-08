package session

import (
	"context"
	"time"
)

// Store persists hashed session cookies, CSRF secrets, and audit events.
type Store interface {
	Create(ctx context.Context, userID string, now time.Time, idle, absolute time.Duration) (Issued, error)
	Lookup(ctx context.Context, token string, now time.Time) (Record, error)
	Refresh(ctx context.Context, token string, now time.Time, idle time.Duration) (Issued, error)
	Revoke(ctx context.Context, token string, now time.Time) (Record, error)
	Touch(ctx context.Context, token string, now time.Time) error
	Audit(ctx context.Context, event AuditEvent) error
	ListAudit(ctx context.Context, userID string, limit int) ([]AuditEvent, error)
}

// Valid reports whether rec is usable at now.
func Valid(rec Record, now time.Time) error {
	if rec.ID == "" || rec.UserID == "" {
		return ErrInvalid
	}
	if rec.RevokedAt != nil && !rec.RevokedAt.After(now) {
		return ErrRevoked
	}
	if !now.Before(rec.IdleExpiresAt) || !now.Before(rec.AbsoluteExpiresAt) {
		return ErrExpired
	}
	return nil
}

func normalizeTimeouts(idle, absolute time.Duration) (time.Duration, time.Duration) {
	if idle <= 0 {
		idle = DefaultIdleTimeout
	}
	if absolute <= 0 {
		absolute = DefaultAbsoluteTimeout
	}
	if idle > absolute {
		idle = absolute
	}
	return idle, absolute
}
