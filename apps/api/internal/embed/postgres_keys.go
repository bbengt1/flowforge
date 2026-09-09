package embed

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// KeysDB is the subset of pgx used by PostgresKeys.
type KeysDB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// PostgresKeys persists overlap public keys.
type PostgresKeys struct {
	db KeysDB
}

// NewPostgresKeys returns a durable overlap store.
func NewPostgresKeys(db KeysDB) *PostgresKeys {
	return &PostgresKeys{db: db}
}

// ListOverlap returns non-expired overlap JWKs.
func (p *PostgresKeys) ListOverlap(ctx context.Context, now time.Time) ([]PublicJWK, error) {
	if p == nil || p.db == nil {
		return nil, ErrStoreUnavailable
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	rows, err := p.db.Query(ctx, `
		SELECT kid, kty, crv, x, use, alg, expires_at
		  FROM embed_overlap_keys
		 WHERE expires_at IS NULL OR expires_at > $1
		 ORDER BY created_at ASC
	`, now.UTC())
	if err != nil {
		return nil, ErrStoreUnavailable
	}
	defer rows.Close()
	var out []PublicJWK
	for rows.Next() {
		var k PublicJWK
		var exp *time.Time
		if err := rows.Scan(&k.Kid, &k.Kty, &k.Crv, &k.X, &k.Use, &k.Alg, &exp); err != nil {
			return nil, ErrStoreUnavailable
		}
		k.Status = KeyStatusOverlap
		if exp != nil {
			k.OverlapUntil = exp.UTC()
		}
		out = append(out, k)
	}
	if err := rows.Err(); err != nil {
		return nil, ErrStoreUnavailable
	}
	if out == nil {
		out = []PublicJWK{}
	}
	return out, nil
}

// RegisterOverlap upserts a public overlap key.
func (p *PostgresKeys) RegisterOverlap(ctx context.Context, key PublicJWK, expiresAt time.Time) error {
	if p == nil || p.db == nil {
		return ErrStoreUnavailable
	}
	norm, err := normalizeOverlapJWK(key)
	if err != nil {
		return err
	}
	var exp any
	if !expiresAt.IsZero() {
		exp = expiresAt.UTC()
	}
	_, err = p.db.Exec(ctx, `
		INSERT INTO embed_overlap_keys (kid, kty, crv, x, use, alg, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (kid) DO UPDATE
		   SET kty = EXCLUDED.kty,
		       crv = EXCLUDED.crv,
		       x = EXCLUDED.x,
		       use = EXCLUDED.use,
		       alg = EXCLUDED.alg,
		       expires_at = EXCLUDED.expires_at
	`, norm.Kid, norm.Kty, norm.Crv, norm.X, norm.Use, norm.Alg, exp)
	if err != nil {
		return mapKeyErr(err)
	}
	return nil
}

// RetireOverlap deletes a kid.
func (p *PostgresKeys) RetireOverlap(ctx context.Context, kid string) error {
	if p == nil || p.db == nil {
		return ErrStoreUnavailable
	}
	kid = strings.TrimSpace(kid)
	if kid == "" {
		return ErrUnknownKey
	}
	tag, err := p.db.Exec(ctx, `DELETE FROM embed_overlap_keys WHERE kid = $1`, kid)
	if err != nil {
		return mapKeyErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrUnknownKey
	}
	return nil
}

func mapKeyErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrUnknownKey
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23514", "22P02":
			return ErrUnknownKey
		}
	}
	return ErrStoreUnavailable
}
