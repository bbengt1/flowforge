package runner

import (
	"context"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func TestUnboundBindingWarnsOnceUntilStateChanges(t *testing.T) {
	h := &recordHandler{}
	log := slog.New(h)
	q := &bindingQueue{view: BindingView{Memberships: 2, Claimable: 0}}
	loop := NewRunner(q, nil, Config{Log: log, PollInterval: time.Hour})
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		if _, err := loop.PollOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if got := h.warnCount(unboundBindingWarn); got != 1 {
		t.Fatalf("boot warns = %d, want 1", got)
	}
	if claimable, ok := h.intAttr(unboundBindingWarn, "claimable"); !ok || claimable != 0 {
		t.Fatalf("claimable = %d ok=%v", claimable, ok)
	}
	if memberships, ok := h.intAttr(unboundBindingWarn, "memberships"); !ok || memberships != 2 {
		t.Fatalf("memberships = %d ok=%v", memberships, ok)
	}

	q.view = BindingView{Memberships: 2, Claimable: 1}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.warnCount(unboundBindingWarn); got != 1 {
		t.Fatalf("bound warns = %d, want 1", got)
	}

	q.view = BindingView{Memberships: 1, Claimable: 0}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.warnCount(unboundBindingWarn); got != 2 {
		t.Fatalf("changed warns = %d, want 2", got)
	}
}

func TestBoundAtBootDoesNotWarnUntilUnbound(t *testing.T) {
	h := &recordHandler{}
	log := slog.New(h)
	q := &bindingQueue{view: BindingView{Memberships: 1, Claimable: 1}}
	loop := NewRunner(q, nil, Config{Log: log, PollInterval: time.Hour})
	ctx := context.Background()
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.warnCount(unboundBindingWarn); got != 0 {
		t.Fatalf("bound boot warns = %d", got)
	}
	q.view = BindingView{Memberships: 1, Claimable: 0}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := loop.PollOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if got := h.warnCount(unboundBindingWarn); got != 1 {
		t.Fatalf("unbound transition warns = %d, want 1", got)
	}
}

const unboundBindingWarn = "runner identity has no workspace binding that allows claiming"

type bindingQueue struct {
	view BindingView
}

func (q *bindingQueue) Workspaces(context.Context) ([]Workspace, error) {
	if q.view.Claimable == 0 {
		return nil, nil
	}
	return []Workspace{{ID: "11111111-1111-4111-8111-111111111111"}}, nil
}

func (q *bindingQueue) BindingView() (BindingView, bool) {
	return q.view, true
}

func (q *bindingQueue) Claim(context.Context, Workspace) (*Job, error)  { return nil, nil }
func (q *bindingQueue) Heartbeat(context.Context, Workspace, Job) error { return nil }
func (q *bindingQueue) Complete(context.Context, Workspace, Job, map[string]any) error {
	return nil
}
func (q *bindingQueue) Fail(context.Context, Workspace, Job, map[string]any) error { return nil }
func (q *bindingQueue) Park(context.Context, Workspace, Job, time.Time) error      { return nil }

type recordHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (h *recordHandler) Enabled(context.Context, slog.Level) bool { return true }

func (h *recordHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.records = append(h.records, r.Clone())
	return nil
}

func (h *recordHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h *recordHandler) WithGroup(string) slog.Handler      { return h }

func (h *recordHandler) warnCount(msg string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, r := range h.records {
		if r.Level == slog.LevelWarn && r.Message == msg {
			n++
		}
	}
	return n
}

func (h *recordHandler) intAttr(msg, key string) (int, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for i := len(h.records) - 1; i >= 0; i-- {
		r := h.records[i]
		if r.Level != slog.LevelWarn || r.Message != msg {
			continue
		}
		var out int
		found := false
		r.Attrs(func(a slog.Attr) bool {
			if a.Key != key {
				return true
			}
			out = int(a.Value.Int64())
			found = true
			return false
		})
		return out, found
	}
	return 0, false
}
