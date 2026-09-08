package session

import (
	"errors"
	"time"
)

// Persistence and lookup errors. Callers must fail closed.
var (
	ErrNotFound         = errors.New("session not found")
	ErrExpired          = errors.New("session expired")
	ErrRevoked          = errors.New("session revoked")
	ErrConflict         = errors.New("session conflict")
	ErrInvalid          = errors.New("invalid session")
	ErrStoreUnavailable = errors.New("session store is unavailable")
)

// Cookie and header names for the browser session pair.
const (
	CookieName     = "ff_session"
	CSRFCookieName = "ff_csrf"
	CSRFHeader     = "X-CSRF-Token"
	CookiePath     = "/api/v1"
)

// Default lifetimes when process config omits overrides.
const (
	DefaultIdleTimeout     = 30 * time.Minute
	DefaultAbsoluteTimeout = 12 * time.Hour
)

// Event types written to session audit (never include cookie or token values).
const (
	EventCreated         = "session.created"
	EventRefreshed       = "session.refreshed"
	EventRevoked         = "session.revoked"
	EventExpired         = "session.expired"
	EventCSRFRejected    = "session.csrf_rejected"
	EventOriginRejected  = "session.origin_rejected"
	EventPrivilegeDenied = "session.privilege_denied"
	EventAuthRejected    = "session.auth_rejected"
	OutcomeAllowed       = "allowed"
	OutcomeDenied        = "denied"
)

// Record is a server-side session. Token and CSRF secrets are never stored
// on this value — only hashes live in the store.
type Record struct {
	ID                string     `json:"id"`
	UserID            string     `json:"-"`
	CreatedAt         time.Time  `json:"created_at"`
	LastSeenAt        time.Time  `json:"last_seen_at"`
	IdleExpiresAt     time.Time  `json:"idle_expires_at"`
	AbsoluteExpiresAt time.Time  `json:"absolute_expires_at"`
	RevokedAt         *time.Time `json:"-"`
	csrfHash          []byte
}

// CSRFHash returns a copy of the stored CSRF hash.
func (r Record) CSRFHash() []byte {
	if len(r.csrfHash) == 0 {
		return nil
	}
	out := make([]byte, len(r.csrfHash))
	copy(out, r.csrfHash)
	return out
}

func (r *Record) setCSRFHash(h []byte) {
	if len(h) == 0 {
		r.csrfHash = nil
		return
	}
	r.csrfHash = append([]byte(nil), h...)
}

// AuditEvent is an append-only session security event.
type AuditEvent struct {
	ID        string    `json:"id"`
	UserID    string    `json:"user_id,omitempty"`
	SessionID string    `json:"session_id,omitempty"`
	EventType string    `json:"event_type"`
	Outcome   string    `json:"outcome"`
	Reason    string    `json:"reason"`
	RequestID string    `json:"request_id,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// Issued is the secret material returned once when a session is created
// or when CSRF is rotated. Never persist or log these values.
type Issued struct {
	Record Record
	Token  string
	CSRF   string
}
