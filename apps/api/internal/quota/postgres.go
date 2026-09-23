package quota

import (
	"context"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// errUnavailable is a store failure. Callers deny the request and must
// not include the limiter key in a log or response.
var errUnavailable = errors.New("rate store unavailable")

// Postgres is the shared store. Auth-door windows and workspace buckets
// live in different tables so those budgets stay distinct.
type Postgres struct {
	db postgres.TxBeginner
}

// NewPostgres returns a PostgreSQL-backed store. A nil beginner fails
// closed on Take and Allow.
func NewPostgres(db postgres.TxBeginner) *Postgres {
	return &Postgres{db: db}
}

// Take consumes one workspace token under FORCE RLS. capacity <= 0 is
// unlimited and does not touch the database.
func (p *Postgres) Take(ctx context.Context, workspaceID, class string, capacity, refillPerSec float64, now time.Time) (Decision, error) {
	if capacity <= 0 {
		return Decision{Allowed: true}, nil
	}
	if p == nil || p.db == nil || !KnownClass(class) || refillPerSec <= 0 {
		return Decision{}, errUnavailable
	}
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		d, err := p.takeOnce(ctx, workspaceID, class, capacity, refillPerSec, now.UTC())
		if err == nil || !uniqueViolation(err) {
			return d, err
		}
		last = err
	}
	if last == nil {
		last = errUnavailable
	}
	return Decision{}, last
}

func (p *Postgres) takeOnce(ctx context.Context, workspaceID, class string, capacity, refillPerSec float64, now time.Time) (Decision, error) {
	tx, err := postgres.BeginScoped(ctx, p.db, workspaceID)
	if err != nil {
		return Decision{}, errUnavailable
	}
	defer tx.Rollback(ctx)

	var tokens float64
	var updated time.Time
	err = tx.QueryRow(ctx, `
		SELECT tokens, updated_at FROM workspace_quotas WHERE bucket = $1 FOR UPDATE
	`, class).Scan(&tokens, &updated)
	if errors.Is(err, pgx.ErrNoRows) {
		if capacity < 1 {
			return Decision{Allowed: false, RetryAfter: time.Minute}, nil
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO workspace_quotas (workspace_id, bucket, tokens, updated_at)
			VALUES (app.current_workspace_id(), $1, $2, $3)
		`, class, capacity-1, now); err != nil {
			return Decision{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Decision{}, errUnavailable
		}
		return Decision{Allowed: true}, nil
	}
	if err != nil {
		return Decision{}, errUnavailable
	}
	available := refill(tokens, updated, now, capacity, refillPerSec)
	if available < 1 {
		return Decision{Allowed: false, RetryAfter: retryFor(available, refillPerSec)}, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workspace_quotas SET tokens = $2, updated_at = $3 WHERE bucket = $1
	`, class, available-1, now); err != nil {
		return Decision{}, errUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return Decision{}, errUnavailable
	}
	return Decision{Allowed: true}, nil
}

// Allow is the shared fixed window for an auth door. limit <= 0 is
// unlimited. The stored key is a hash. A database error denies.
func (p *Postgres) Allow(ctx context.Context, key string, limit int, window time.Duration, now time.Time) (bool, time.Duration, error) {
	if limit <= 0 {
		return true, 0, nil
	}
	if p == nil || p.db == nil {
		return false, time.Minute, errUnavailable
	}
	if window <= 0 {
		window = time.Minute
	}
	now = now.UTC()
	var last error
	for attempt := 0; attempt < 2; attempt++ {
		ok, retry, err := p.allowOnce(ctx, KeyHash(key), limit, window, now)
		if err == nil || !uniqueViolation(err) {
			return ok, retry, err
		}
		last = err
	}
	if last == nil {
		last = errUnavailable
	}
	return false, window, last
}

func (p *Postgres) allowOnce(ctx context.Context, hash string, limit int, window time.Duration, now time.Time) (bool, time.Duration, error) {
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return false, window, errUnavailable
	}
	defer tx.Rollback(ctx)

	var start time.Time
	var count int
	err = tx.QueryRow(ctx, `
		SELECT window_start, count FROM auth_rate_windows WHERE key_hash = $1 FOR UPDATE
	`, hash).Scan(&start, &count)
	if errors.Is(err, pgx.ErrNoRows) {
		if _, err := tx.Exec(ctx, `
			INSERT INTO auth_rate_windows (key_hash, window_start, count) VALUES ($1, $2, 1)
		`, hash, now); err != nil {
			return false, window, err
		}
		if err := tx.Commit(ctx); err != nil {
			return false, window, errUnavailable
		}
		return true, 0, nil
	}
	if err != nil {
		return false, window, errUnavailable
	}
	if now.Sub(start) >= window {
		if _, err := tx.Exec(ctx, `
			UPDATE auth_rate_windows SET window_start = $2, count = 1 WHERE key_hash = $1
		`, hash, now); err != nil {
			return false, window, errUnavailable
		}
		if err := tx.Commit(ctx); err != nil {
			return false, window, errUnavailable
		}
		return true, 0, nil
	}
	if count >= limit {
		retry := window - now.Sub(start)
		if retry < time.Second {
			retry = time.Second
		}
		return false, retry, nil
	}
	if _, err := tx.Exec(ctx, `
		UPDATE auth_rate_windows SET count = count + 1 WHERE key_hash = $1
	`, hash); err != nil {
		return false, window, errUnavailable
	}
	if err := tx.Commit(ctx); err != nil {
		return false, window, errUnavailable
	}
	return true, 0, nil
}

func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
