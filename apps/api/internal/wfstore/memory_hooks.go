package wfstore

import "sync"

// hookMutex is Memory's store lock. Work queued with afterUnlock runs
// right after the lock is released, on the goroutine that releases it,
// so a call into another store (the approval store takes its own lock and
// calls back into this one) never runs under this lock (#668 M2).
type hookMutex struct {
	sync.Mutex
	after []func()
}

// afterUnlock queues fn to run once the lock is released. The caller
// holds the lock.
func (h *hookMutex) afterUnlock(fn func()) {
	h.after = append(h.after, fn)
}

func (h *hookMutex) Unlock() {
	fns := h.after
	h.after = nil
	h.Mutex.Unlock()
	for _, fn := range fns {
		fn()
	}
}
