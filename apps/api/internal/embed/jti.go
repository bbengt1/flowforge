package embed

import (
	"context"
	"sync"
	"time"
)

// JTIConsumer is the atomic one-time token-id hook.
//
// Production uses PostgresJTI (single INSERT … ON CONFLICT DO NOTHING
// RETURNING). MemoryJTI remains for process-local tests. Consume must
// fail closed if the store is unavailable. Used ids are retained past
// assertion exp for JTIRetention; purge is a separate job.
type JTIConsumer interface {
	Consume(ctx context.Context, jti string, expiresAt time.Time) error
}

// JTIPurger drops consumed ids only after retain_until (exp + JTIRetention).
// It must not run inside Consume.
type JTIPurger interface {
	PurgeExpired(ctx context.Context, now time.Time) (int, error)
}

// MemoryJTI is the fail-closed in-process consumer: first use succeeds,
// replay returns ErrReplay. Used ids stay until PurgeExpired after
// retain_until (assertion exp + JTIRetention).
type MemoryJTI struct {
	mu   sync.Mutex
	seen map[string]time.Time // jti → retain_until
}

// NewMemoryJTI returns an empty in-process consumer.
func NewMemoryJTI() *MemoryJTI {
	return &MemoryJTI{seen: map[string]time.Time{}}
}

// Consume marks jti used until retain_until. Replay fails closed.
func (s *MemoryJTI) Consume(ctx context.Context, jti string, expiresAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return ErrStoreUnavailable
	}
	if s == nil {
		return ErrStoreUnavailable
	}
	jti = trimJTI(jti)
	if jti == "" {
		return ErrTokenID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil {
		s.seen = map[string]time.Time{}
	}
	// Presence is replay regardless of wall-clock TTL. Verify already
	// enforces nbf/exp against the request clock; GC must not drop a
	// consumed jti at assertion exp (ADV-009).
	if _, ok := s.seen[jti]; ok {
		return ErrReplay
	}
	now := time.Now().UTC()
	s.seen[jti] = jtiRetainUntil(expiresAt, now)
	return nil
}

// PurgeExpired removes ids whose retain_until has elapsed. Rows still
// inside the retention window (including after JWT exp) stay.
func (s *MemoryJTI) PurgeExpired(ctx context.Context, now time.Time) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, ErrStoreUnavailable
	}
	if s == nil {
		return 0, ErrStoreUnavailable
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.seen == nil {
		return 0, nil
	}
	n := 0
	for id, until := range s.seen {
		if !until.After(now) {
			delete(s.seen, id)
			n++
		}
	}
	return n, nil
}

func jtiRetainUntil(expiresAt, now time.Time) time.Time {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if expiresAt.IsZero() {
		expiresAt = now.Add(DefaultTTL)
	}
	return expiresAt.UTC().Add(JTIRetention)
}

func trimJTI(jti string) string {
	for len(jti) > 0 && (jti[0] == ' ' || jti[0] == '\t') {
		jti = jti[1:]
	}
	for len(jti) > 0 && (jti[len(jti)-1] == ' ' || jti[len(jti)-1] == '\t') {
		jti = jti[:len(jti)-1]
	}
	return jti
}

// RotationHook reports whether kid is the active key or an explicit
// overlap verification key. Unknown kids fail closed.
func RotationHook(m Material, kid string) error {
	if kid == "" || kid == m.KeyID {
		return nil
	}
	if overlapHasKid(m, kid, time.Time{}) {
		return nil
	}
	return ErrUnknownKey
}
