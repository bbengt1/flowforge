package scim

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

// Postgres persists directory rows. The bearer token is not stored.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Save(ctx context.Context, rec Record) error {
	rec, err := normalize(rec)
	if err != nil {
		return err
	}
	var deprov any
	if rec.DeprovisionedAt != nil {
		deprov = rec.DeprovisionedAt.UTC()
	}
	_, err = p.db.Exec(ctx, `
		INSERT INTO scim_users (user_id, user_name, external_id, deprovisioned_at, created_at, updated_at)
		VALUES ($1::uuid, $2, $3, $4, $5, $6)
		ON CONFLICT (user_id) DO UPDATE
		    SET user_name = EXCLUDED.user_name,
		        external_id = EXCLUDED.external_id,
		        deprovisioned_at = EXCLUDED.deprovisioned_at,
		        updated_at = EXCLUDED.updated_at
	`, rec.UserID, rec.UserName, rec.ExternalID, deprov, rec.CreatedAt.UTC(), rec.UpdatedAt.UTC())
	if err != nil {
		return mapErr(err)
	}
	return nil
}

func (p *Postgres) Get(ctx context.Context, userID string) (Record, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return Record{}, ErrNotFound
	}
	return p.one(ctx, `
		SELECT user_id::text, user_name, external_id, deprovisioned_at, created_at, updated_at
		  FROM scim_users
		 WHERE user_id = $1::uuid
	`, userID)
}

func (p *Postgres) FindByUserName(ctx context.Context, userName string) (Record, error) {
	userName = strings.TrimSpace(userName)
	if userName == "" {
		return Record{}, ErrNotFound
	}
	return p.one(ctx, `
		SELECT user_id::text, user_name, external_id, deprovisioned_at, created_at, updated_at
		  FROM scim_users
		 WHERE lower(user_name) = lower($1)
		 ORDER BY (deprovisioned_at IS NULL) DESC, updated_at DESC
		 LIMIT 1
	`, userName)
}

func (p *Postgres) FindByExternalID(ctx context.Context, externalID string) (Record, error) {
	externalID = strings.TrimSpace(externalID)
	if externalID == "" {
		return Record{}, ErrNotFound
	}
	return p.one(ctx, `
		SELECT user_id::text, user_name, external_id, deprovisioned_at, created_at, updated_at
		  FROM scim_users
		 WHERE external_id = $1
		 ORDER BY (deprovisioned_at IS NULL) DESC, updated_at DESC
		 LIMIT 1
	`, externalID)
}

func (p *Postgres) List(ctx context.Context, attr, value string, startIndex, count int) ([]Record, int, error) {
	if startIndex < 1 || count < 0 {
		return nil, 0, ErrInvalid
	}
	if attr != "" && attr != "userName" && attr != "externalId" && attr != "id" {
		return nil, 0, ErrInvalid
	}
	if attr == "id" && value != "" && !looksUUID(value) {
		return nil, 0, ErrInvalid
	}
	where, args := listWhere(attr, value)
	var total int
	if err := p.db.QueryRow(ctx, `SELECT COUNT(*) FROM scim_users `+where, args...).Scan(&total); err != nil {
		return nil, 0, mapErr(err)
	}
	if count == 0 || startIndex > total {
		return nil, total, nil
	}
	args = append(args, count, startIndex-1)
	rows, err := p.db.Query(ctx, `
		SELECT user_id::text, user_name, external_id, deprovisioned_at, created_at, updated_at
		  FROM scim_users `+where+`
		 ORDER BY created_at, user_id
		 LIMIT $`+placeholder(len(args)-1)+` OFFSET $`+placeholder(len(args)), args...)
	if err != nil {
		return nil, 0, mapErr(err)
	}
	defer rows.Close()
	var out []Record
	for rows.Next() {
		rec, err := scanRecord(rows.Scan)
		if err != nil {
			return nil, 0, mapErr(err)
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, mapErr(err)
	}
	return out, total, nil
}

func (p *Postgres) one(ctx context.Context, query string, arg any) (Record, error) {
	rec, err := scanRecord(func(dest ...any) error {
		return p.db.QueryRow(ctx, query, arg).Scan(dest...)
	})
	if err != nil {
		return Record{}, mapErr(err)
	}
	return rec, nil
}

func scanRecord(scan func(dest ...any) error) (Record, error) {
	var rec Record
	var deprov *time.Time
	if err := scan(&rec.UserID, &rec.UserName, &rec.ExternalID, &deprov, &rec.CreatedAt, &rec.UpdatedAt); err != nil {
		return Record{}, err
	}
	rec.DeprovisionedAt = deprov
	return rec, nil
}

func listWhere(attr, value string) (string, []any) {
	switch attr {
	case "userName":
		return `WHERE deprovisioned_at IS NULL AND lower(user_name) = lower($1)`, []any{value}
	case "externalId":
		return `WHERE deprovisioned_at IS NULL AND external_id = $1 AND external_id <> ''`, []any{value}
	case "id":
		return `WHERE deprovisioned_at IS NULL AND user_id = $1::uuid`, []any{value}
	default:
		return `WHERE deprovisioned_at IS NULL`, nil
	}
}

func placeholder(n int) string {
	if n < 1 {
		n = 1
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}

func looksUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if (r < '0' || r > '9') && (r < 'a' || r > 'f') && (r < 'A' || r > 'F') {
				return false
			}
		}
	}
	return true
}

func mapErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrConflict
		case "23503", "22P02":
			return ErrInvalid
		}
	}
	if errors.Is(err, ErrNotFound) || errors.Is(err, ErrConflict) || errors.Is(err, ErrInvalid) {
		return err
	}
	return ErrUnavailable
}
