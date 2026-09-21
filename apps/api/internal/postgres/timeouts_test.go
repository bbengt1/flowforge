package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestTimeoutsFromEnvDefaultsAndOverrides(t *testing.T) {
	t.Setenv(EnvStatementTimeout, "")
	t.Setenv(EnvLockTimeout, "")
	got := TimeoutsFromEnv()
	if got.Statement != DefaultStatementTimeout || got.Lock != DefaultLockTimeout {
		t.Fatalf("defaults = %+v", got)
	}

	t.Setenv(EnvStatementTimeout, "8s")
	t.Setenv(EnvLockTimeout, "2s")
	got = TimeoutsFromEnv()
	if got.Statement != 8*time.Second || got.Lock != 2*time.Second {
		t.Fatalf("overrides = %+v", got)
	}

	t.Setenv(EnvStatementTimeout, "nope")
	t.Setenv(EnvLockTimeout, "0s")
	got = TimeoutsFromEnv()
	if got.Statement != DefaultStatementTimeout || got.Lock != DefaultLockTimeout {
		t.Fatalf("invalid should fall back, got %+v", got)
	}

	t.Setenv(EnvStatementTimeout, "1h")
	t.Setenv(EnvLockTimeout, "10m")
	got = TimeoutsFromEnv()
	if got.Statement != maxStatementTimeout || got.Lock != maxLockTimeout {
		t.Fatalf("clamp = %+v", got)
	}

	t.Setenv(EnvStatementTimeout, "3s")
	t.Setenv(EnvLockTimeout, "10s")
	got = TimeoutsFromEnv()
	if got.Lock != 3*time.Second {
		t.Fatalf("lock should not exceed statement, got %+v", got)
	}
}

func TestFormatTimeoutMilliseconds(t *testing.T) {
	if got := formatTimeout(15 * time.Second); got != "15000" {
		t.Fatalf("formatTimeout(15s) = %q", got)
	}
	if got := formatTimeout(time.Microsecond); got != "1" {
		t.Fatalf("sub-millisecond should be 1ms, got %q", got)
	}
}

func TestApplySessionTimeoutsIssuesSetConfig(t *testing.T) {
	rec := &recordingExec{}
	timeouts := Timeouts{Statement: 8 * time.Second, Lock: 2 * time.Second}
	if err := applySessionTimeouts(context.Background(), rec, timeouts); err != nil {
		t.Fatal(err)
	}
	if len(rec.calls) != 2 {
		t.Fatalf("calls = %d, want 2: %+v", len(rec.calls), rec.calls)
	}
	if rec.calls[0].sql != `SELECT set_config('statement_timeout', $1, false)` || rec.calls[0].arg != "8000" {
		t.Fatalf("statement call = %+v", rec.calls[0])
	}
	if rec.calls[1].sql != `SELECT set_config('lock_timeout', $1, false)` || rec.calls[1].arg != "2000" {
		t.Fatalf("lock call = %+v", rec.calls[1])
	}
}

func TestApplyPoolHooksInstallsBeforeAcquire(t *testing.T) {
	cfg, err := pgxpool.ParseConfig("postgres://flowforge:flowforge@127.0.0.1:5432/flowforge?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	applyPoolHooksWith(cfg, false, DefaultTimeouts())
	if cfg.BeforeAcquire == nil {
		t.Fatal("expected BeforeAcquire to apply session timeouts")
	}
}

func TestCheckoutAppliesTimeouts(t *testing.T) {
	dsn := testDatabaseURL()
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL / DATABASE_URL not set")
	}

	t.Setenv(EnvStatementTimeout, "8s")
	t.Setenv(EnvLockTimeout, "2s")

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	pool, err := Open(ctx, dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer pool.Close()

	stmt, lock := showTimeouts(t, ctx, pool)
	if !pgTimeoutEquals(stmt, 8*time.Second) {
		t.Fatalf("statement_timeout after checkout = %q, want 8s", stmt)
	}
	if !pgTimeoutEquals(lock, 2*time.Second) {
		t.Fatalf("lock_timeout after checkout = %q, want 2s", lock)
	}

	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	if _, err := conn.Exec(ctx, `SET statement_timeout TO 0`); err != nil {
		conn.Release()
		t.Fatalf("disable statement_timeout: %v", err)
	}
	if _, err := conn.Exec(ctx, `SET lock_timeout TO 0`); err != nil {
		conn.Release()
		t.Fatalf("disable lock_timeout: %v", err)
	}
	conn.Release()

	stmt, lock = showTimeouts(t, ctx, pool)
	if !pgTimeoutEquals(stmt, 8*time.Second) {
		t.Fatalf("statement_timeout after re-checkout = %q, want 8s", stmt)
	}
	if !pgTimeoutEquals(lock, 2*time.Second) {
		t.Fatalf("lock_timeout after re-checkout = %q, want 2s", lock)
	}
}

func showTimeouts(t *testing.T, ctx context.Context, pool *pgxpool.Pool) (statement, lock string) {
	t.Helper()
	if err := pool.QueryRow(ctx, `SHOW statement_timeout`).Scan(&statement); err != nil {
		t.Fatalf("SHOW statement_timeout: %v", err)
	}
	if err := pool.QueryRow(ctx, `SHOW lock_timeout`).Scan(&lock); err != nil {
		t.Fatalf("SHOW lock_timeout: %v", err)
	}
	return statement, lock
}

func pgTimeoutEquals(shown string, want time.Duration) bool {
	switch shown {
	case formatTimeout(want) + "ms", formatTimeout(want):
		return true
	}
	if d, err := time.ParseDuration(shown); err == nil {
		return d == want
	}
	return false
}

func testDatabaseURL() string {
	if dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL")); dsn != "" {
		return dsn
	}
	return strings.TrimSpace(os.Getenv("DATABASE_URL"))
}

type recordingExec struct {
	calls []recordedExec
}

type recordedExec struct {
	sql string
	arg string
}

func (r *recordingExec) Exec(_ context.Context, sql string, arguments ...any) (pgconn.CommandTag, error) {
	arg := ""
	if len(arguments) > 0 {
		if s, ok := arguments[0].(string); ok {
			arg = s
		}
	}
	r.calls = append(r.calls, recordedExec{sql: sql, arg: arg})
	return pgconn.NewCommandTag("SELECT 1"), nil
}
