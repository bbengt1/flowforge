// Package scheduler is the in-process leader that ticks schedule
// dispatch, lease recovery, and retention purge. Replicas share one
// Postgres advisory lock; only the holder runs the hooks. No external
// cron caller is required for those three.
package scheduler

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"sync/atomic"
	"time"
)

const (
	// EnvEnabled opts the API process in or out. Empty defaults to on.
	// 0/false/no/off disables. Any other value is a boot-fail.
	EnvEnabled = "SCHEDULER_ENABLED"
	// EnvInterval is the leader tick period (Go duration, 1s–24h).
	EnvInterval = "SCHEDULER_INTERVAL"

	// DefaultInterval is the tick period when SCHEDULER_INTERVAL is unset.
	DefaultInterval = 30 * time.Second

	// LockKey is the session advisory lock that elects the leader.
	// Distinct from the migration lock (881726401). Held on one
	// application-pool connection (SET ROLE flowforge_app). It does not
	// bypass FORCE RLS; workspace work uses separate scoped transactions.
	LockKey int64 = 881726402

	// followerRetry is how often a replica that does not hold the lock
	// campaigns again. Shorter than a long tick so failover is not stuck
	// behind a 30s interval. Tests may set Config.Retry lower.
	followerRetry = 5 * time.Second

	// leaseWatch is how often the leader rechecks the advisory lock
	// while a hook is running. A lost lease cancels that hook and does
	// not start the next one.
	leaseWatch = 20 * time.Millisecond
)

// Hooks are the three maintenance operations. Nil funcs are skipped.
// Implementations must keep FORCE RLS, HMAC fencing, and drafts-never-run.
type Hooks struct {
	Dispatch func(ctx context.Context) error
	Recover  func(ctx context.Context) error
	Purge    func(ctx context.Context) error
}

// Session is a held leadership. Lost is true when this process no longer
// owns the lock (connection drop, or the advisory lock is no longer
// granted to that session). Release drops the lock. Lost must be safe to
// call on the leadership connection while a hook runs elsewhere.
type Session interface {
	Lost(ctx context.Context) bool
	Release(ctx context.Context)
}

// Elector campaigns for leadership. acquired is false when another
// replica holds the lock. A non-nil error is retryable (database down).
type Elector interface {
	Campaign(ctx context.Context) (session Session, acquired bool, err error)
}

// Config controls one scheduler loop.
type Config struct {
	Interval time.Duration
	// Retry is how often a follower campaigns. Zero uses followerRetry,
	// or Interval when that is shorter.
	Retry   time.Duration
	Elector Elector
	Hooks   Hooks
	Log     *slog.Logger
}

// Scheduler runs hooks on Interval while it holds leadership.
type Scheduler struct {
	cfg Config
}

// New returns a scheduler. A nil elector makes Run fail closed.
func New(cfg Config) *Scheduler {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &Scheduler{cfg: cfg}
}

// Run campaigns until ctx is cancelled. Only the leader calls hooks.
// Cancellation is a clean stop (nil error).
func (s *Scheduler) Run(ctx context.Context) error {
	if s == nil || s.cfg.Elector == nil {
		return fmt.Errorf("scheduler elector is not configured")
	}
	for {
		if ctx.Err() != nil {
			return nil
		}
		session, ok, err := s.cfg.Elector.Campaign(ctx)
		if err != nil || !ok {
			if err != nil {
				s.cfg.Log.Warn("scheduler leadership unavailable", "error", safeError(err))
			}
			if !sleep(ctx, s.retryEvery()) {
				return nil
			}
			continue
		}
		s.cfg.Log.Info("scheduler leading", "interval", s.interval().String())
		s.lead(ctx, session)
		session.Release(ctx)
		if ctx.Err() != nil {
			return nil
		}
	}
}

func (s *Scheduler) lead(ctx context.Context, session Session) {
	ticker := time.NewTicker(s.interval())
	defer ticker.Stop()
	for {
		if !s.tick(ctx, session) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// tick runs the three hooks while session still holds the lease.
// False means stop leading: ctx is done, or the lease was lost before
// or during a hook. A lost lease cancels the in-flight hook and skips
// every hook that has not started.
func (s *Scheduler) tick(ctx context.Context, session Session) bool {
	if ctx.Err() != nil {
		return false
	}
	if session.Lost(ctx) {
		s.noteLost()
		return false
	}
	if s.cfg.Log != nil {
		s.cfg.Log.Info("scheduler tick")
	}
	if !s.call(ctx, session, "dispatch", s.cfg.Hooks.Dispatch) {
		return false
	}
	if !s.call(ctx, session, "recover", s.cfg.Hooks.Recover) {
		return false
	}
	return s.call(ctx, session, "purge", s.cfg.Hooks.Purge)
}

// call runs one hook. It returns false when leadership must end.
// A hook error while the lease is still held is logged and the tick
// continues. The lease is rechecked before the hook starts, and again
// while it runs, on the leadership connection only.
func (s *Scheduler) call(ctx context.Context, session Session, name string, fn func(context.Context) error) bool {
	if ctx.Err() != nil {
		return false
	}
	if session.Lost(ctx) {
		s.noteLost()
		return false
	}
	if fn == nil {
		return true
	}
	hookCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var leaseLost atomic.Bool
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchLease(ctx, hookCtx, session, cancel, &leaseLost)
	}()
	err := fn(hookCtx)
	cancel()
	<-done
	if ctx.Err() != nil {
		return false
	}
	if leaseLost.Load() {
		s.noteLost()
		return false
	}
	if err != nil && s.cfg.Log != nil {
		s.cfg.Log.Error("scheduler hook failed", "hook", name, "error", safeError(err))
	}
	return true
}

func (s *Scheduler) noteLost() {
	if s.cfg.Log != nil {
		s.cfg.Log.Info("scheduler leadership lost")
	}
}

// watchLease polls the leadership connection until the hook finishes or
// the lease is gone. The poll uses the parent context so cancelling the
// hook does not look like a dropped lock.
func watchLease(parent, hook context.Context, session Session, cancel context.CancelFunc, lost *atomic.Bool) {
	ticker := time.NewTicker(leaseWatch)
	defer ticker.Stop()
	for {
		select {
		case <-hook.Done():
			return
		case <-parent.Done():
			return
		case <-ticker.C:
			if session.Lost(parent) {
				lost.Store(true)
				cancel()
				return
			}
		}
	}
}

func (s *Scheduler) interval() time.Duration {
	if s.cfg.Interval > 0 {
		return s.cfg.Interval
	}
	return DefaultInterval
}

func (s *Scheduler) retryEvery() time.Duration {
	if s.cfg.Retry > 0 {
		return s.cfg.Retry
	}
	if iv := s.interval(); iv < followerRetry {
		return iv
	}
	return followerRetry
}

var (
	userinfoURL = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s]*:[^/\s@]*@`)
	secretKV    = regexp.MustCompile(`(?i)(password|passwd|secret|token|api_key)=([^\s&]+)`)
)

// safeError strips DSNs and password fields before a log line. Hook and
// campaign failures must not print secrets.
func safeError(err error) string {
	if err == nil {
		return ""
	}
	msg := userinfoURL.ReplaceAllString(err.Error(), `${1}[redacted]@`)
	return secretKV.ReplaceAllString(msg, `${1}=[redacted]`)
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// EnabledFromEnv reports whether the scheduler should run.
// Empty is enabled. Unknown values fail closed.
func EnabledFromEnv(raw string) (bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return true, nil
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("%s must be 1/true/yes/on or 0/false/no/off", EnvEnabled)
	}
}

// IntervalFromEnv parses the tick period. Empty is DefaultInterval.
// Values outside 1s–24h fail closed.
func IntervalFromEnv(raw string) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultInterval, nil
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < time.Second || d > 24*time.Hour {
		return 0, fmt.Errorf("%s must be a Go duration from 1s to 24h", EnvInterval)
	}
	return d, nil
}
