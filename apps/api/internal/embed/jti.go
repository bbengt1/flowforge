package embed

import (
	"sync"
	"time"
)

// JTIConsumer is the E11.2 atomic one-time token-id hook.
//
// E11.1 ships an in-process MemoryJTI that rejects replay in the same
// process. It is not durable across pods or restarts. A production
// Postgres consume (INSERT … ON CONFLICT / compare-and-set with TTL)
// belongs to E11.2 and must fail closed if the store is unavailable.
type JTIConsumer interface {
	Consume(jti string, expiresAt time.Time) error
}

// MemoryJTI is the E11.1 fail-closed stub: first use succeeds, replay
// returns ErrReplay. Entries expire after the assertion TTL.
type MemoryJTI struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

// NewMemoryJTI returns an empty in-process consumer.
func NewMemoryJTI() *MemoryJTI {
	return &MemoryJTI{seen: map[string]time.Time{}}
}

// Consume marks jti used until expiresAt. Replay fails closed.
func (s *MemoryJTI) Consume(jti string, expiresAt time.Time) error {
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
	if _, ok := s.seen[jti]; ok {
		return ErrReplay
	}
	// Time bounds are enforced by Verify. E11.2 durable consume adds TTL GC.
	if expiresAt.IsZero() {
		expiresAt = time.Now().UTC().Add(DefaultTTL)
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

// RotationHook documents E11.2 active/overlap rotation. E11.1 verifies
// the active key only and returns ErrRotationUnready for overlap-only kids.
func RotationHook(m Material, kid string) error {
	if kid == "" || kid == m.KeyID {
		return nil
	}
	if overlapHasKid(m, kid) {
		return nil
	}
	return ErrRotationUnready
}

// TenancyPropagationHook is the E11.2 fail-closed stub. E11.1 validates
// (tenant_id, workbench_key) and optional workspace binding, then leaves
// session workspace attachment to existing request headers.
func TenancyPropagationHook() error {
	return ErrTenancyUnready
}
