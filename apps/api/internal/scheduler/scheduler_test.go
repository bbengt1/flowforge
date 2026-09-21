package scheduler

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func TestEnabledAndIntervalFromEnv(t *testing.T) {
	on, err := EnabledFromEnv("")
	if err != nil || !on {
		t.Fatalf("empty enabled = %v %v", on, err)
	}
	off, err := EnabledFromEnv("off")
	if err != nil || off {
		t.Fatalf("off = %v %v", off, err)
	}
	if _, err := EnabledFromEnv("maybe"); err == nil {
		t.Fatal("unknown SCHEDULER_ENABLED must fail closed")
	}
	d, err := IntervalFromEnv("")
	if err != nil || d != DefaultInterval {
		t.Fatalf("default interval = %s %v", d, err)
	}
	d, err = IntervalFromEnv("45s")
	if err != nil || d != 45*time.Second {
		t.Fatalf("45s = %s %v", d, err)
	}
	if _, err := IntervalFromEnv("50ms"); err == nil {
		t.Fatal("sub-second interval must fail closed")
	}
	if _, err := IntervalFromEnv("48h"); err == nil {
		t.Fatal("interval above 24h must fail closed")
	}
	if LockKey == 881726401 {
		t.Fatal("scheduler lock must stay distinct from the migration advisory lock")
	}
}

func TestOnlyLeaderTicksOnInterval(t *testing.T) {
	lock := &sharedLock{}
	var leader, follower atomic.Int32
	ctxLeader, stopLeader := context.WithCancel(context.Background())
	ctxFollower, stopFollower := context.WithCancel(context.Background())
	defer stopFollower()

	errCh := make(chan error, 2)
	go func() {
		errCh <- New(Config{
			Interval: 20 * time.Millisecond,
			Retry:    5 * time.Millisecond,
			Elector:  lock.elector("leader"),
			Hooks:    countHooks(&leader),
			Log:      slog.New(slog.DiscardHandler),
		}).Run(ctxLeader)
	}()

	// Each tick runs dispatch, recover, and purge. Two ticks are 6 calls,
	// so the count proves the interval fired after the immediate tick.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && leader.Load() < 6 {
		time.Sleep(5 * time.Millisecond)
	}
	if leader.Load() < 6 {
		t.Fatalf("leader hook calls = %d, want at least 6 (two ticks)", leader.Load())
	}
	go func() {
		errCh <- New(Config{
			Interval: 20 * time.Millisecond,
			Retry:    5 * time.Millisecond,
			Elector:  lock.elector("follower"),
			Hooks:    countHooks(&follower),
			Log:      slog.New(slog.DiscardHandler),
		}).Run(ctxFollower)
	}()
	// Give the follower several campaigns while the lock is held.
	time.Sleep(40 * time.Millisecond)
	if follower.Load() != 0 {
		t.Fatalf("follower ticked %d times while another replica held the lock", follower.Load())
	}

	stopLeader()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && follower.Load() < 3 {
		time.Sleep(5 * time.Millisecond)
	}
	if follower.Load() < 3 {
		t.Fatalf("follower did not tick after the leader released, count=%d", follower.Load())
	}
	stopFollower()
	for range 2 {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("scheduler did not stop")
		}
	}
}

func TestAdvisoryLockPartsMatchPostgresSplit(t *testing.T) {
	classid, objid := advisoryLockParts(LockKey)
	if classid != 0 || objid != LockKey {
		t.Fatalf("lock key parts = %d, %d", classid, objid)
	}
	classid, objid = advisoryLockParts((1 << 32) | 7)
	if classid != 1 || objid != 7 {
		t.Fatalf("high-bit parts = %d, %d", classid, objid)
	}
}

func TestLostLeaseBeforeTickRunsNoHooks(t *testing.T) {
	var n atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = New(Config{
			Interval: time.Hour,
			Retry:    5 * time.Millisecond,
			Elector: electorFunc(func(ctx context.Context) (Session, bool, error) {
				if ctx.Err() != nil {
					return nil, false, ctx.Err()
				}
				return lostSession{}, true, nil
			}),
			Hooks: countHooks(&n),
			Log:   slog.New(slog.DiscardHandler),
		}).Run(ctx)
	}()
	time.Sleep(40 * time.Millisecond)
	if n.Load() != 0 {
		t.Fatalf("hooks ran without a lease: %d", n.Load())
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not stop")
	}
	if n.Load() != 0 {
		t.Fatalf("hooks ran without a lease: %d", n.Load())
	}
}

func TestLoseLeaseStopsHooksImmediately(t *testing.T) {
	lock := &sharedLock{}
	var retired atomic.Bool
	sess := &leaseSession{lock: lock, id: "leader"}
	var dispatch, recoverN, purge atomic.Int32
	entered := make(chan struct{})
	finished := make(chan struct{})
	var enteredOnce, finishedOnce sync.Once
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 2)
	go func() {
		errCh <- New(Config{
			Interval: 10 * time.Millisecond,
			Retry:    5 * time.Millisecond,
			Elector: electorFunc(func(ctx context.Context) (Session, bool, error) {
				if ctx.Err() != nil {
					return nil, false, ctx.Err()
				}
				lock.mu.Lock()
				defer lock.mu.Unlock()
				if retired.Load() || (lock.owner != "" && lock.owner != "leader") {
					return nil, false, nil
				}
				lock.owner = "leader"
				return sess, true, nil
			}),
			Hooks: Hooks{
				Dispatch: func(ctx context.Context) error {
					dispatch.Add(1)
					enteredOnce.Do(func() { close(entered) })
					<-ctx.Done()
					finishedOnce.Do(func() { close(finished) })
					return ctx.Err()
				},
				Recover: func(context.Context) error {
					recoverN.Add(1)
					return nil
				},
				Purge: func(context.Context) error {
					purge.Add(1)
					return nil
				},
			},
			Log: slog.New(slog.DiscardHandler),
		}).Run(ctx)
	}()

	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("leader did not start dispatch")
	}
	sess.drop(&retired)
	select {
	case <-finished:
	case <-time.After(2 * time.Second):
		t.Fatal("in-flight dispatch was not cancelled when the lease was lost")
	}
	time.Sleep(50 * time.Millisecond)
	if dispatch.Load() != 1 || recoverN.Load() != 0 || purge.Load() != 0 {
		t.Fatalf("orphan tick after lease loss: dispatch=%d recover=%d purge=%d", dispatch.Load(), recoverN.Load(), purge.Load())
	}

	var follower atomic.Int32
	ctxFollower, stopFollower := context.WithCancel(context.Background())
	defer stopFollower()
	go func() {
		errCh <- New(Config{
			Interval: 10 * time.Millisecond,
			Retry:    5 * time.Millisecond,
			Elector:  lock.elector("follower"),
			Hooks:    countHooks(&follower),
			Log:      slog.New(slog.DiscardHandler),
		}).Run(ctxFollower)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && follower.Load() < 3 {
		time.Sleep(5 * time.Millisecond)
	}
	if follower.Load() < 3 {
		t.Fatalf("follower did not tick after the leader lost the lease, count=%d", follower.Load())
	}
	if dispatch.Load() != 1 || recoverN.Load() != 0 || purge.Load() != 0 {
		t.Fatalf("former leader ticked after the follower took the lock: dispatch=%d recover=%d purge=%d", dispatch.Load(), recoverN.Load(), purge.Load())
	}
	cancel()
	stopFollower()
	for range 2 {
		select {
		case err := <-errCh:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(2 * time.Second):
			t.Fatal("scheduler did not stop")
		}
	}
}

func TestSchedulerHookErrorDoesNotLogSecrets(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	lock := &sharedLock{}
	ctx, cancel := context.WithCancel(context.Background())
	secret := "postgres://flowforge:s3cret-pass@db.internal/flowforge"
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = New(Config{
			Interval: time.Hour,
			Elector:  lock.elector("only"),
			Hooks: Hooks{
				Dispatch: func(context.Context) error { return fmt.Errorf("dial %s", secret) },
				Recover:  func(context.Context) error { return nil },
				Purge:    func(context.Context) error { return nil },
			},
			Log: log,
		}).Run(ctx)
	}()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && !strings.Contains(buf.String(), "scheduler hook failed") && !strings.Contains(buf.String(), "[redacted]") {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scheduler did not stop")
	}
	out := buf.String()
	if strings.Contains(out, "s3cret-pass") || strings.Contains(out, secret) {
		t.Fatalf("scheduler log leaked a secret: %s", out)
	}
	if !strings.Contains(out, "scheduler tick") {
		t.Fatalf("expected a tick log, got %s", out)
	}
}

func countHooks(n *atomic.Int32) Hooks {
	fn := func(context.Context) error {
		n.Add(1)
		return nil
	}
	return Hooks{Dispatch: fn, Recover: fn, Purge: fn}
}

type sharedLock struct {
	mu    sync.Mutex
	owner string
}

func (s *sharedLock) elector(id string) Elector {
	return electorFunc(func(ctx context.Context) (Session, bool, error) {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.owner != "" && s.owner != id {
			return nil, false, nil
		}
		s.owner = id
		return &sharedSession{lock: s, id: id}, true, nil
	})
}

type sharedSession struct {
	lock *sharedLock
	id   string
}

func (s *sharedSession) Lost(context.Context) bool { return false }

type lostSession struct{}

func (lostSession) Lost(context.Context) bool { return true }
func (lostSession) Release(context.Context)   {}

// leaseSession is a leader whose connection can die mid-hook. drop
// releases the shared lock the way a dead Postgres session would, and
// retires this replica so it does not campaign again.
type leaseSession struct {
	lock *sharedLock
	id   string
	mu   sync.Mutex
	lost bool
}

func (s *leaseSession) Lost(context.Context) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lost
}

func (s *leaseSession) Release(context.Context) {
	s.mu.Lock()
	lost := s.lost
	s.mu.Unlock()
	if lost {
		return
	}
	s.lock.mu.Lock()
	defer s.lock.mu.Unlock()
	if s.lock.owner == s.id {
		s.lock.owner = ""
	}
}

func (s *leaseSession) drop(retired *atomic.Bool) {
	s.mu.Lock()
	s.lost = true
	s.mu.Unlock()
	s.lock.mu.Lock()
	retired.Store(true)
	if s.lock.owner == s.id {
		s.lock.owner = ""
	}
	s.lock.mu.Unlock()
}

func (s *sharedSession) Release(context.Context) {
	s.lock.mu.Lock()
	defer s.lock.mu.Unlock()
	if s.lock.owner == s.id {
		s.lock.owner = ""
	}
}

type electorFunc func(context.Context) (Session, bool, error)

func (f electorFunc) Campaign(ctx context.Context) (Session, bool, error) { return f(ctx) }
