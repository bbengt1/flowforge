package scheduler

import (
	"context"
	"fmt"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// PostgresElector elects a leader with pg_try_advisory_lock on one
// application-pool connection. The connection stays checked out for the
// life of the session so the lock cannot return to the pool still held.
// Workspace queries run on other connections under FORCE RLS.
type PostgresElector struct {
	pool *postgres.Pool
}

// NewPostgresElector returns an elector for the API pool. The pool must
// already assume flowforge_app on checkout.
func NewPostgresElector(pool *postgres.Pool) *PostgresElector {
	return &PostgresElector{pool: pool}
}

// Campaign tries the advisory lock once. A false acquired means another
// replica is leader.
func (e *PostgresElector) Campaign(ctx context.Context) (Session, bool, error) {
	if e == nil || e.pool == nil {
		return nil, false, fmt.Errorf("scheduler database is not configured")
	}
	conn, err := e.pool.Acquire(ctx)
	if err != nil {
		return nil, false, err
	}
	var held bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, LockKey).Scan(&held); err != nil {
		conn.Destroy(ctx)
		return nil, false, fmt.Errorf("scheduler lock: %w", err)
	}
	if !held {
		conn.Release()
		return nil, false, nil
	}
	return &pgSession{conn: conn}, true, nil
}

type pgSession struct {
	conn *postgres.Conn
}

func (s *pgSession) Lost(ctx context.Context) bool {
	if s == nil || s.conn == nil {
		return true
	}
	var one int
	if err := s.conn.QueryRow(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
		return true
	}
	return false
}

func (s *pgSession) Release(ctx context.Context) {
	if s == nil || s.conn == nil {
		return
	}
	conn := s.conn
	s.conn = nil
	if _, err := conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, LockKey); err != nil {
		// Drop the session. Returning it would leave the lock on a pooled
		// connection and block every replica.
		conn.Destroy(ctx)
		return
	}
	conn.Release()
}
