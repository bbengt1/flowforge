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

// consumeJTI SQL is a single statement: insert or conflict. No
// check-then-insert and no DELETE. Zero RETURNING rows means replay.
const consumeJTISQL = `
		INSERT INTO embed_assertion_jtis (jti, expires_at, consumed_at, retain_until)
		VALUES ($1::uuid, $2, $3, $4)
		ON CONFLICT (jti) DO NOTHING
		RETURNING jti
	`

const purgeJTISQL = `
		DELETE FROM embed_assertion_jtis WHERE retain_until <= $1
	`

// JTIDB is the subset of pgx used by PostgresJTI.
type JTIDB interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// PostgresJTI atomically consumes assertion token IDs.
// One statement: INSERT … ON CONFLICT DO NOTHING RETURNING.
// Used ids are retained until retain_until (assertion exp + JTIRetention).
// PurgeExpired is a separate job and must not run inside Consume.
type PostgresJTI struct {
	db JTIDB
}

// NewPostgresJTI returns a durable consumer. db must not be nil.
func NewPostgresJTI(db JTIDB) *PostgresJTI {
	return &PostgresJTI{db: db}
}

// Consume inserts jti until retain_until in one statement. Replay and
// store failure fail closed.
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
	retainUntil := jtiRetainUntil(expiresAt, now)
	var consumed string
	err := p.db.QueryRow(ctx, consumeJTISQL, jti, expiresAt, now, retainUntil).Scan(&consumed)
	if err != nil {
		return mapJTIErr(err)
	}
	return nil
}

// PurgeExpired deletes consumed ids whose retain_until has elapsed.
// It never deletes solely because JWT exp has passed.
func (p *PostgresJTI) PurgeExpired(ctx context.Context, now time.Time) (int, error) {
	if p == nil || p.db == nil {
		return 0, ErrStoreUnavailable
	}
	if err := ctx.Err(); err != nil {
		return 0, ErrStoreUnavailable
	}
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}
	tag, err := p.db.Exec(ctx, purgeJTISQL, now)
	if err != nil {
		return 0, mapJTIErr(err)
	}
	return int(tag.RowsAffected()), nil
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
