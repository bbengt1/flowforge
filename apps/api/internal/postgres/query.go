package postgres

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// applyPoolHooks resets leftover session GUCs on checkout and, when
// assumeAppRole is true, assumes flowforge_app so FORCE RLS cannot be bypassed
// by a superuser login role leftover from Docker/CI.
func applyPoolHooks(cfg *pgxpool.Config, assumeAppRole bool) {
	cfg.BeforeAcquire = func(ctx context.Context, conn *pgx.Conn) bool {
		if _, err := conn.Exec(ctx, `SELECT set_config('app.workspace_id', '', false)`); err != nil {
			return false
		}
		if assumeAppRole {
			if _, err := conn.Exec(ctx, `SET ROLE `+AppRole); err != nil {
				return false
			}
		}
		return true
	}
	if assumeAppRole {
		cfg.AfterRelease = func(conn *pgx.Conn) bool {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_, err := conn.Exec(ctx, `RESET ROLE`)
			return err == nil
		}
	}
}

func (p *Pool) live() (*pgxpool.Pool, error) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	if p.pool == nil {
		return nil, ErrUnavailable
	}
	return p.pool, nil
}

// Query delegates to the live pool.
func (p *Pool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	live, err := p.live()
	if err != nil {
		return nil, err
	}
	return live.Query(ctx, sql, args...)
}

// QueryRow delegates to the live pool.
func (p *Pool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	live, err := p.live()
	if err != nil {
		return errRow{err: err}
	}
	return live.QueryRow(ctx, sql, args...)
}

// Exec delegates to the live pool.
func (p *Pool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	live, err := p.live()
	if err != nil {
		return pgconn.CommandTag{}, err
	}
	return live.Exec(ctx, sql, args...)
}

// Begin starts a transaction on the live pool.
func (p *Pool) Begin(ctx context.Context) (pgx.Tx, error) {
	live, err := p.live()
	if err != nil {
		return nil, err
	}
	return live.Begin(ctx)
}

type errRow struct{ err error }

func (r errRow) Scan(dest ...any) error { return r.err }
