package embed

import (
	"context"
	"sync"
	"time"
)

// JTIConsumer is the atomic one-time token-id hook.
//
// Production uses PostgresJTI (INSERT … ON CONFLICT DO NOTHING with TTL).
// MemoryJTI remains for process-local tests. Consume must fail closed if
// the store is unavailable.
type JTIConsumer interface {
	Consume(ctx context.Context, jti string, expiresAt time.Time) error
}

// MemoryJTI is the fail-closed in-process consumer: first use succeeds,
// replay returns ErrReplay. Entries expire after the assertion TTL.
type MemoryJTI struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// NewMemoryJTI returns an empty in-process consumer.
func NewMemoryJTI() *MemoryJTI {
	return &MemoryJTI{seen: map[string]time.Time{}}
}

// Consume marks jti used until expiresAt. Replay fails closed.
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
	// consumed jti that is still valid under a mocked test clock.
	if _, ok := s.seen[jti]; ok {
		return ErrReplay
	}
	now := time.Now().UTC()
	if expiresAt.IsZero() {
		expiresAt = now.Add(DefaultTTL)
	}
	s.seen[jti] = expiresAt.UTC()
	return nil
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
