package runner

import (
	"context"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunFinishesInFlightClaimOnCancel(t *testing.T) {
	q := &blockQueue{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	r := NewRunner(q, nil, Config{
		WorkerID:     "flowforge-runner-a",
		PollInterval: time.Hour,
		DrainTimeout: 2 * time.Second,
		Log:          slog.New(slog.DiscardHandler),
	})
	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		errCh <- r.Run(ctx)
	}()
	select {
	case <-q.started:
	case <-time.After(2 * time.Second):
		t.Fatal("claim did not start")
	}
	cancel()
	time.Sleep(40 * time.Millisecond)
	if q.claims.Load() != 1 {
		t.Fatalf("drain started another claim: %d", q.claims.Load())
	}
	if q.cancelled.Load() {
		t.Fatal("in-flight claim was cancelled before the drain budget")
	}
	close(q.release)
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not finish the in-flight claim")
	}
	if q.claims.Load() != 1 || q.cancelled.Load() {
		t.Fatalf("claims=%d cancelled=%v", q.claims.Load(), q.cancelled.Load())
	}
}

func TestRunCancelsClaimWhenDrainBudgetEnds(t *testing.T) {
	q := &blockQueue{
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	r := NewRunner(q, nil, Config{
		WorkerID:     "flowforge-runner-b",
		PollInterval: time.Hour,
		DrainTimeout: 40 * time.Millisecond,
		Log:          slog.New(slog.DiscardHandler),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errCh := make(chan error, 1)
	go func() {
		errCh <- r.Run(ctx)
	}()
	select {
	case <-q.started:
	case <-time.After(2 * time.Second):
		t.Fatal("claim did not start")
	}
	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("runner did not stop after the drain budget")
	}
	if !q.cancelled.Load() {
		t.Fatal("claim was not cancelled when the drain budget elapsed")
	}
	if q.claims.Load() != 1 {
		t.Fatalf("claims=%d", q.claims.Load())
	}
}

type blockQueue struct {
	started   chan struct{}
	release   chan struct{}
	claims    atomic.Int32
	cancelled atomic.Bool
}

func (q *blockQueue) Workspaces(context.Context) ([]Workspace, error) {
	return []Workspace{{ID: "11111111-1111-4111-8111-111111111111"}}, nil
}

func (q *blockQueue) Claim(ctx context.Context, _ Workspace) (*Job, error) {
	n := q.claims.Add(1)
	if n == 1 {
		close(q.started)
		select {
		case <-q.release:
			return nil, nil
		case <-ctx.Done():
			q.cancelled.Store(true)
			return nil, ctx.Err()
		}
	}
	return nil, nil
}

func (q *blockQueue) Heartbeat(context.Context, Workspace, Job) error { return nil }
func (q *blockQueue) Complete(context.Context, Workspace, Job, map[string]any) error {
	return nil
}
func (q *blockQueue) Fail(context.Context, Workspace, Job, map[string]any) error { return nil }
func (q *blockQueue) Park(context.Context, Workspace, Job, time.Time) error      { return nil }
