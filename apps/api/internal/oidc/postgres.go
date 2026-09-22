package oidc

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

// Postgres persists one-time PKCE transactions.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

// Put inserts a transaction and drops expired rows.
func (p *Postgres) Put(ctx context.Context, tx Tx) error {
	if len(tx.StateHash) != sha256Len || tx.Nonce == "" || len(tx.VerifierBlob) == 0 || tx.ID == "" {
		return ErrInvalid
	}
	if _, err := p.db.Exec(ctx, `DELETE FROM oidc_auth_transactions WHERE expires_at < $1`, tx.ExpiresAt.UTC()); err != nil {
		return ErrUnavailable
	}
	_, err := p.db.Exec(ctx, `
		INSERT INTO oidc_auth_transactions (
			id, state_hash, verifier_ciphertext, nonce, expires_at, created_at
		) VALUES ($1::uuid, $2, $3, $4, $5, $6)
	`, tx.ID, tx.StateHash, tx.VerifierBlob, tx.Nonce, tx.ExpiresAt.UTC(), time.Now().UTC())
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ErrInvalid
		}
		return ErrUnavailable
	}
	return nil
}

// Consume returns a live transaction and marks it used.
func (p *Postgres) Consume(ctx context.Context, stateHash []byte, now time.Time) (Tx, error) {
	if len(stateHash) != sha256Len {
		return Tx{}, ErrRejected
	}
	now = now.UTC()
	var tx Tx
	err := p.db.QueryRow(ctx, `
		UPDATE oidc_auth_transactions
		   SET consumed_at = $2
		 WHERE state_hash = $1
		   AND consumed_at IS NULL
		   AND expires_at > $2
		 RETURNING id::text, state_hash, verifier_ciphertext, nonce, expires_at
	`, stateHash, now).Scan(&tx.ID, &tx.StateHash, &tx.VerifierBlob, &tx.Nonce, &tx.ExpiresAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return Tx{}, ErrRejected
		}
		return Tx{}, ErrUnavailable
	}
	return tx, nil
}
