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

// Material returns a snapshot with env + runtime overlap merged and
// expired overlap keys dropped.
func (r *Ring) Material() Material {
	return r.MaterialAt(time.Now().UTC())
}

// MaterialAt is Material evaluated at now (overlapUntil / retire).
func (r *Ring) MaterialAt(now time.Time) Material {
	if r == nil {
		return Material{}
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.snapshotLocked(now)
}

func (r *Ring) snapshotLocked(now time.Time) Material {
	m := r.active
	seen := map[string]struct{}{}
	out := make([]PublicJWK, 0, len(m.Overlap)+len(r.runtime))
	add := func(k PublicJWK) {
		if k.Kid == "" || k.Kid == m.KeyID {
			return
		}
		if !OverlapStillValid(k.OverlapUntil, now) {
			return
		}
		if _, ok := seen[k.Kid]; ok {
			return
		}
		seen[k.Kid] = struct{}{}
		out = append(out, k)
	}
	// Store-backed runtime first so a refresh from another instance wins
	// over a stale env copy of the same kid.
	for _, k := range r.runtime {
		add(k)
	}
	for _, k := range m.Overlap {
		add(k)
	}
	m.Overlap = out
	return m
}

// PublicJWKS never includes private keys.
func (r *Ring) PublicJWKS() JWKS {
	return r.Material().PublicJWKS()
}

// Refresh pulls durable overlap keys into the runtime set and drops
// expired in-memory overlap (overlapUntil). Call this on the verify
// path so multi-instance rotate/retire is visible and stale rings do
// not accept retired or expired keys forever.
func (r *Ring) Refresh(ctx context.Context, now time.Time) error {
	if r == nil {
		return nil
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if r.store != nil {
		if ctx == nil {
			ctx = context.Background()
		}
		keys, err := r.store.ListOverlap(ctx, now)
		if err != nil {
			return err
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.runtime = keys
		r.active.Overlap = filterLiveOverlap(r.active.Overlap, now)
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.runtime = filterLiveOverlap(r.runtime, now)
	r.active.Overlap = filterLiveOverlap(r.active.Overlap, now)
	return nil
}

// Verify refreshes overlap from the durable store, refuses expired or
// retired overlap keys, then verifies the assertion.
func (r *Ring) Verify(ctx context.Context, token string, opt VerifyOptions) (Verified, error) {
	if r == nil {
		return Verified{}, ErrKeyUnavailable
	}
	now := opt.Now
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if opt.Context == nil {
		opt.Context = ctx
	}
	if err := r.Refresh(ctx, now); err != nil {
		return Verified{}, err
	}
	return Verify(r.MaterialAt(now), token, opt)
}

// AddOverlap registers the current active public key as overlap so a
// later active-key deploy can verify in-flight assertions. Arbitrary
// caller-supplied Ed25519 keys are rejected fail-closed. expiresAt is
// required and must be a short window (max MaxOverlapTTL).
func (r *Ring) AddOverlap(ctx context.Context, key PublicJWK, expiresAt, now time.Time) error {
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
	if err := ValidateOverlapUntil(expiresAt, now); err != nil {
		return err
	}
	norm.OverlapUntil = expiresAt.UTC()
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
		k := row.key
		k.OverlapUntil = row.expiresAt
		out = append(out, k)
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
	if expiresAt.IsZero() {
		return ErrOverlapUntilRequired
	}
	norm.OverlapUntil = expiresAt.UTC()
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
