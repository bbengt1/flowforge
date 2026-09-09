package embed

import (
	"context"
	"crypto/subtle"
	"strings"
	"sync"
	"time"
)

// KeyStore persists overlap verification keys so all API pods share the
// rotation window. Private material is never stored.
type KeyStore interface {
	ListOverlap(ctx context.Context, now time.Time) ([]PublicJWK, error)
	RegisterOverlap(ctx context.Context, key PublicJWK, expiresAt time.Time) error
	RetireOverlap(ctx context.Context, kid string) error
}

// Ring is the process key set: mint with the active key; verify accepts
// active plus explicitly overlapping public keys.
type Ring struct {
	mu      sync.RWMutex
	active  Material
	runtime []PublicJWK
	store   KeyStore
}

// NewRing wraps signing material. store may be nil (env/runtime only).
func NewRing(active Material, store KeyStore) *Ring {
	if active.Overlap == nil {
		active.Overlap = []PublicJWK{}
	}
	return &Ring{active: active, store: store}
}

// Ready reports whether mint can run.
func (r *Ring) Ready() bool {
	if r == nil {
		return false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.active.Ready()
}

// KeyID is the active signing kid.
func (r *Ring) KeyID() string {
	if r == nil {
		return ""
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.active.KeyID
}

// Material returns a snapshot with env + runtime overlap merged.
func (r *Ring) Material() Material {
	if r == nil {
		return Material{}
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.snapshotLocked()
}

func (r *Ring) snapshotLocked() Material {
	m := r.active
	seen := map[string]struct{}{}
	out := make([]PublicJWK, 0, len(m.Overlap)+len(r.runtime))
	for _, k := range m.Overlap {
		if k.Kid == m.KeyID {
			continue
		}
		seen[k.Kid] = struct{}{}
		out = append(out, k)
	}
	for _, k := range r.runtime {
		if k.Kid == m.KeyID {
			continue
		}
		if _, ok := seen[k.Kid]; ok {
			continue
		}
		seen[k.Kid] = struct{}{}
		out = append(out, k)
	}
	m.Overlap = out
	return m
}

// PublicJWKS never includes private keys.
func (r *Ring) PublicJWKS() JWKS {
	return r.Material().PublicJWKS()
}

// Refresh pulls durable overlap keys into the runtime set.
func (r *Ring) Refresh(ctx context.Context, now time.Time) error {
	if r == nil || r.store == nil {
		return nil
	}
	keys, err := r.store.ListOverlap(ctx, now)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.runtime = keys
	return nil
}

// AddOverlap registers the current active public key as overlap so a
// later active-key deploy can verify in-flight assertions. Arbitrary
// caller-supplied Ed25519 keys are rejected fail-closed.
func (r *Ring) AddOverlap(ctx context.Context, key PublicJWK, expiresAt time.Time) error {
	if r == nil {
		return ErrKeyUnavailable
	}
	norm, err := normalizeOverlapJWK(key)
	if err != nil {
		return err
	}
	r.mu.RLock()
	match := r.matchesActiveLocked(norm)
	r.mu.RUnlock()
	if !match {
		return ErrOverlapNotPrior
	}
	if r.store != nil {
		if err := r.store.RegisterOverlap(ctx, norm, expiresAt); err != nil {
			return err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	replaced := false
	for i, k := range r.runtime {
		if k.Kid == norm.Kid {
			r.runtime[i] = norm
			replaced = true
			break
		}
	}
	if !replaced {
		r.runtime = append(r.runtime, norm)
	}
	return nil
}

// RetireOverlap removes a verification key after the overlap window.
func (r *Ring) RetireOverlap(ctx context.Context, kid string) error {
	if r == nil {
		return ErrKeyUnavailable
	}
	kid = strings.TrimSpace(kid)
	if kid == "" {
		return ErrUnknownKey
	}
	if r.store != nil {
		if err := r.store.RetireOverlap(ctx, kid); err != nil {
			return err
		}
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.runtime[:0]
	found := false
	for _, k := range r.runtime {
		if k.Kid == kid {
			found = true
			continue
		}
		out = append(out, k)
	}
	r.runtime = out
	env := r.active.Overlap[:0]
	for _, k := range r.active.Overlap {
		if k.Kid == kid {
			found = true
			continue
		}
		env = append(env, k)
	}
	r.active.Overlap = env
	if !found {
		return ErrUnknownKey
	}
	return nil
}

// InstallActive replaces the process signing key after the prior active
// public key has been registered as overlap. Production does this by
// restarting with a new EMBED_SIGNING_KEY; tests use this handoff.
func (r *Ring) InstallActive(next Material) error {
	if r == nil || !next.Ready() {
		return ErrKeyUnavailable
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	env := r.active.Overlap
	r.active = next
	if r.active.Overlap == nil {
		r.active.Overlap = env
	}
	return nil
}

func (r *Ring) matchesActiveLocked(key PublicJWK) bool {
	if !r.active.Ready() {
		return false
	}
	if strings.TrimSpace(key.Kid) != r.active.KeyID {
		return false
	}
	got, err := decodePublicX(key.X)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, r.active.Public) == 1
}

// MemoryKeys is an in-process KeyStore for tests.
type MemoryKeys struct {
	mu   sync.Mutex
	keys map[string]overlapRow
}

type overlapRow struct {
	key       PublicJWK
	expiresAt time.Time
}

// NewMemoryKeys returns an empty overlap store.
func NewMemoryKeys() *MemoryKeys {
	return &MemoryKeys{keys: map[string]overlapRow{}}
}

// ListOverlap returns non-expired overlap keys.
func (m *MemoryKeys) ListOverlap(_ context.Context, now time.Time) ([]PublicJWK, error) {
	if m == nil {
		return nil, ErrStoreUnavailable
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []PublicJWK
	for _, row := range m.keys {
		if !OverlapStillValid(row.expiresAt, now) {
			continue
		}
		out = append(out, row.key)
	}
	return out, nil
}

// RegisterOverlap stores a public overlap key.
func (m *MemoryKeys) RegisterOverlap(_ context.Context, key PublicJWK, expiresAt time.Time) error {
	if m == nil {
		return ErrStoreUnavailable
	}
	norm, err := normalizeOverlapJWK(key)
	if err != nil {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.keys == nil {
		m.keys = map[string]overlapRow{}
	}
	m.keys[norm.Kid] = overlapRow{key: norm, expiresAt: expiresAt.UTC()}
	return nil
}

// RetireOverlap deletes a kid.
func (m *MemoryKeys) RetireOverlap(_ context.Context, kid string) error {
	if m == nil {
		return ErrStoreUnavailable
	}
	kid = strings.TrimSpace(kid)
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.keys[kid]; !ok {
		return ErrUnknownKey
	}
	delete(m.keys, kid)
	return nil
}
