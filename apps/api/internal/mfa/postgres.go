package mfa

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the subset of pgx used by Postgres.
type DB interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Postgres persists encrypted TOTP factors.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

// PutPending inserts or replaces an unconfirmed secret.
func (p *Postgres) PutPending(ctx context.Context, userID string, ciphertext []byte, now time.Time) error {
	if userID == "" || len(ciphertext) == 0 {
		return ErrInvalid
	}
	now = now.UTC()
	var id string
	err := p.db.QueryRow(ctx, `
		INSERT INTO user_mfa_totp (user_id, secret_ciphertext, created_at, updated_at)
		VALUES ($1::uuid, $2, $3, $3)
		ON CONFLICT (user_id) DO UPDATE
		    SET secret_ciphertext = EXCLUDED.secret_ciphertext,
		        confirmed_at = NULL,
		        last_step = 0,
		        updated_at = EXCLUDED.updated_at
		  WHERE user_mfa_totp.confirmed_at IS NULL
		RETURNING user_id::text
	`, userID, ciphertext, now).Scan(&id)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrConflict
		}
		return ErrUnavailable
	}
	return nil
}

// Get returns the factor. The ciphertext is still encrypted.
func (p *Postgres) Get(ctx context.Context, userID string) (Factor, error) {
	var f Factor
	var confirmedAt *time.Time
	err := p.db.QueryRow(ctx, `
		SELECT user_id::text, secret_ciphertext, confirmed_at, last_step
		  FROM user_mfa_totp
		 WHERE user_id = $1::uuid
	`, userID).Scan(&f.UserID, &f.Ciphertext, &confirmedAt, &f.LastStep)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Factor{}, ErrNotFound
		}
		return Factor{}, ErrUnavailable
	}
	f.Confirmed = confirmedAt != nil
	return f, nil
}

// Accept records a successful code.
func (p *Postgres) Accept(ctx context.Context, userID string, step int64, confirm bool, now time.Time) error {
	now = now.UTC()
	var confirmedArg any
	if confirm {
		confirmedArg = now
	}
	tag, err := p.db.Exec(ctx, `
		UPDATE user_mfa_totp
		   SET last_step = $2,
		       confirmed_at = COALESCE(confirmed_at, $3),
		       updated_at = $4
		 WHERE user_id = $1::uuid
		   AND last_step < $2
	`, userID, step, confirmedArg, now)
	if err != nil {
		return ErrUnavailable
	}
	if tag.RowsAffected() == 0 {
		return ErrRejected
	}
	return nil
}
