// Package lockout persists failed-authentication counters for local
// login and OIDC. The in-process login rate limit stays separate and
// resets on process restart; this store does not.
package lockout

import (
	"context"
	"errors"
	"time"
)

const (
	// DefaultMaxFailures locks an account after this many bad local
	// passwords when LOCKOUT_MAX_FAILURES is unset.
	DefaultMaxFailures = 5
	MinMaxFailures     = 1
	MaxMaxFailures     = 50
)

// Errors. HTTP details stay static and never include passwords.
var (
	ErrInvalid     = errors.New("invalid lockout")
	ErrUnavailable = errors.New("lockout store unavailable")
)

// State is the durable counter for one user. A zero UserID is empty.
// LockedAt set means sign-in stays denied across process restarts
// until an admin unlocks the account.
type State struct {
	UserID    string
	Failed    int
	LockedAt  *time.Time
	UpdatedAt time.Time
}

// Locked reports whether the account cannot sign in.
func (s State) Locked() bool {
	return s.LockedAt != nil && !s.LockedAt.IsZero()
}

// Store is the durable lockout record. Postgres is the production
// implementation. Memory is the test double and is only durable for
// as long as the caller keeps the same value.
type Store interface {
	// NoteFailure increments the counter and sets LockedAt once Failed
	// reaches max. The counter does not grow past max. Missing rows
	// are created. max < 1 is ErrInvalid.
	NoteFailure(ctx context.Context, userID string, max int, now time.Time) (State, error)
	// Get returns the row. A user with no row is a zero State and a nil error.
	Get(ctx context.Context, userID string) (State, error)
	// Clear removes the counter after a successful sign-in that was not locked.
	Clear(ctx context.Context, userID string) error
	// Unlock removes the counter. It does not change users.status.
	// Missing rows are a nil error.
	Unlock(ctx context.Context, userID string) error
}
