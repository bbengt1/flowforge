package quota

import (
	"context"
	"sync"
	"time"
)

// Memory is the single-process token bucket. FLOWFORGE_REPLICAS above 1
// must not boot with it. Keys are workspace id plus class.
type Memory struct {
	mu      sync.Mutex
	buckets map[string]bucketState
}

type bucketState struct {
	tokens  float64
	updated time.Time
}

// NewMemory returns an empty in-memory bucket store.
func NewMemory() *Memory {
	return &Memory{buckets: map[string]bucketState{}}
}

// Take consumes one token. capacity <= 0 is unlimited and does not record
// a bucket. The first call in a bucket starts full.
func (m *Memory) Take(_ context.Context, workspaceID, class string, capacity, refillPerSec float64, now time.Time) (Decision, error) {
	if m == nil {
		return Decision{}, errUnavailable
	}
	if capacity <= 0 {
		return Decision{Allowed: true}, nil
	}
	if !KnownClass(class) || refillPerSec <= 0 || workspaceID == "" {
		return Decision{}, errUnavailable
	}
	now = now.UTC()
	key := workspaceID + "\x00" + class
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.buckets == nil {
		m.buckets = map[string]bucketState{}
	}
	st, ok := m.buckets[key]
	var available float64
	if !ok {
		available = capacity
	} else {
		available = refill(st.tokens, st.updated, now, capacity, refillPerSec)
	}
	if available < 1 {
		m.buckets[key] = bucketState{tokens: available, updated: now}
		return Decision{Allowed: false, RetryAfter: retryFor(available, refillPerSec)}, nil
	}
	m.buckets[key] = bucketState{tokens: available - 1, updated: now}
	return Decision{Allowed: true}, nil
}
