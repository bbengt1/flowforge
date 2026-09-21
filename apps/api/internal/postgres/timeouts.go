package postgres

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

const (
	// DefaultStatementTimeout aborts a single SQL statement that outlives
	// the API write deadline. A pathological query then cannot occupy a
	// pool slot until the client disconnects.
	DefaultStatementTimeout = 15 * time.Second
	// DefaultLockTimeout fails a blocked lock wait before it can pin a
	// pool connection behind another session.
	DefaultLockTimeout = 5 * time.Second

	maxStatementTimeout = 5 * time.Minute
	maxLockTimeout      = time.Minute
	minTimeout          = time.Millisecond

	EnvStatementTimeout = "STATEMENT_TIMEOUT"
	EnvLockTimeout      = "LOCK_TIMEOUT"
)

// Timeouts are session GUCs applied on every application-pool checkout
// (pgxpool PrepareConn).
type Timeouts struct {
	Statement time.Duration
	Lock      time.Duration
}

// DefaultTimeouts returns the documented production defaults.
func DefaultTimeouts() Timeouts {
	return Timeouts{Statement: DefaultStatementTimeout, Lock: DefaultLockTimeout}
}

// TimeoutsFromEnv reads STATEMENT_TIMEOUT / LOCK_TIMEOUT (Go duration
// strings, e.g. 15s). Missing, zero, or invalid values keep the defaults.
// Values are clamped so an oversized override cannot disable protection.
func TimeoutsFromEnv() Timeouts {
	t := DefaultTimeouts()
	if d, ok := parsePositiveDuration(os.Getenv(EnvStatementTimeout)); ok {
		t.Statement = d
	}
	if d, ok := parsePositiveDuration(os.Getenv(EnvLockTimeout)); ok {
		t.Lock = d
	}
	return t.clamp()
}

func (t Timeouts) clamp() Timeouts {
	t.Statement = clampDuration(t.Statement, DefaultStatementTimeout, maxStatementTimeout)
	t.Lock = clampDuration(t.Lock, DefaultLockTimeout, maxLockTimeout)
	if t.Lock > t.Statement {
		t.Lock = t.Statement
	}
	return t
}

func clampDuration(d, fallback, max time.Duration) time.Duration {
	if d < minTimeout {
		return fallback
	}
	if d > max {
		return max
	}
	return d
}

func parsePositiveDuration(raw string) (time.Duration, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, false
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d < minTimeout {
		return 0, false
	}
	return d, true
}

// formatTimeout is the millisecond integer string PostgreSQL accepts for
// statement_timeout / lock_timeout via set_config.
func formatTimeout(d time.Duration) string {
	ms := d.Milliseconds()
	if ms < 1 {
		ms = 1
	}
	return strconv.FormatInt(ms, 10)
}

type sessionExecer interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
}

func applySessionTimeouts(ctx context.Context, exec sessionExecer, t Timeouts) error {
	t = t.clamp()
	if _, err := exec.Exec(ctx, `SELECT set_config('statement_timeout', $1, false)`, formatTimeout(t.Statement)); err != nil {
		return err
	}
	if _, err := exec.Exec(ctx, `SELECT set_config('lock_timeout', $1, false)`, formatTimeout(t.Lock)); err != nil {
		return err
	}
	return nil
}
