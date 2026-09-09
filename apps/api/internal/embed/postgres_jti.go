package embed

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// JTIDB is the subset of pgx used by PostgresJTI.
type JTIDB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresJTI atomically consumes assertion token IDs with TTL.
// INSERT … ON CONFLICT DO NOTHING: zero rows means replay.
type PostgresJTI struct {
	db JTIDB
}

// NewPostgresJTI returns a durable consumer. db must not be nil.
func NewPostgresJTI(db JTIDB) *PostgresJTI {
	return &PostgresJTI{db: db}
}

// Consume inserts jti until expiresAt. Replay and store failure fail closed.
func (p *PostgresJTI) Consume(ctx context.Context, jti string, expiresAt time.Time) error {
	if p == nil || p.db == nil {
		return ErrStoreUnavailable
	}
	if err := ctx.Err(); err != nil {
		return ErrStoreUnavailable
	}
	jti = trimJTI(jti)
	if !authz.ValidUUID(jti) {
		return ErrTokenID
	}
	now := time.Now().UTC()
	if expiresAt.IsZero() {
		expiresAt = now.Add(DefaultTTL)
	}
	expiresAt = expiresAt.UTC()
	// Drop expired rows so a reused UUID after TTL can be issued again.
	if _, err := p.db.Exec(ctx, `DELETE FROM embed_assertion_jtis WHERE expires_at <= $1`, now); err != nil {
		return mapJTIErr(err)
	}
	tag, err := p.db.Exec(ctx, `
		INSERT INTO embed_assertion_jtis (jti, expires_at, consumed_at)
		VALUES ($1::uuid, $2, $3)
		ON CONFLICT (jti) DO NOTHING
	`, jti, expiresAt, now)
	if err != nil {
		return mapJTIErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrReplay
	}
	return nil
}

func mapJTIErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrReplay
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrReplay
		case "22P02":
			return ErrTokenID
		}
	}
	if strings.Contains(strings.ToLower(err.Error()), "not reachable") ||
		strings.Contains(strings.ToLower(err.Error()), "unavailable") {
		return ErrStoreUnavailable
	}
	return ErrStoreUnavailable
}
