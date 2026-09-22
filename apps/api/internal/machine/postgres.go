package machine

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists machine principals.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Create(ctx context.Context, in Input) (Principal, error) {
	row, err := normalizeInput(in)
	if err != nil {
		return Principal{}, err
	}
	tx, err := p.db.Begin(ctx)
	if err != nil {
		return Principal{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var pub any
	if len(row.publicKey) > 0 {
		pub = row.publicKey
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO machine_principals (
			id, user_id, client_id, display_name, secret_hash, assertion_public_key,
			status, tenant_id, workspace_id, workbench_key, created_at, updated_at
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, $6,
			'active', $7::uuid, $8::uuid, $9, $10, $10
		)
		RETURNING id::text
	`, row.ID, row.UserID, row.ClientID, row.DisplayName, row.secretHash, pub,
		uuidArg(row.TenantID), uuidArg(row.WorkspaceID), row.WorkbenchKey, row.CreatedAt,
	).Scan(&row.ID)
	if err != nil {
		return Principal{}, mapDBErr(err)
	}
	if err := insertGrants(ctx, tx, row.ID, row.Grants); err != nil {
		return Principal{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Principal{}, err
	}
	return row.clone(), nil
}

func (p *Postgres) Get(ctx context.Context, id string) (Principal, error) {
	id = strings.TrimSpace(id)
	if !authz.ValidUUID(id) {
		return Principal{}, ErrInvalid
	}
	return p.load(ctx, `id = $1::uuid`, id)
}

func (p *Postgres) GetByClientID(ctx context.Context, clientID string) (Principal, error) {
	clientID, err := NormalizeClientID(clientID)
	if err != nil {
		return Principal{}, err
	}
	return p.load(ctx, `client_id = $1`, clientID)
}

func (p *Postgres) GetByUserID(ctx context.Context, userID string) (Principal, error) {
	userID = strings.TrimSpace(userID)
	if !authz.ValidUUID(userID) {
		return Principal{}, ErrInvalid
	}
	return p.load(ctx, `user_id = $1::uuid`, userID)
}

func (p *Postgres) List(ctx context.Context) ([]Principal, error) {
	rows, err := p.db.Query(ctx, `
		SELECT id::text FROM machine_principals ORDER BY created_at, client_id
	`)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, mapDBErr(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	out := make([]Principal, 0, len(ids))
	for _, id := range ids {
		item, err := p.Get(ctx, id)
		if err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	if out == nil {
		out = []Principal{}
	}
	return out, nil
}

func (p *Postgres) Rotate(ctx context.Context, id string, rot Rotation) (Principal, error) {
	cur, err := p.Get(ctx, id)
	if err != nil {
		return Principal{}, err
	}
	if cur.Status != StatusActive {
		return Principal{}, ErrRevoked
	}
	next, err := applyRotation(cur, rot)
	if err != nil {
		return Principal{}, err
	}
	var pub any
	if len(next.publicKey) > 0 {
		pub = next.publicKey
	}
	tag, err := p.db.Exec(ctx, `
		UPDATE machine_principals
		   SET secret_hash = $2,
		       assertion_public_key = $3,
		       rotated_at = $4,
		       updated_at = $4
		 WHERE id = $1::uuid
		   AND status = 'active'
	`, next.ID, next.secretHash, pub, next.UpdatedAt)
	if err != nil {
		return Principal{}, mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return Principal{}, ErrRevoked
	}
	return next.clone(), nil
}

func (p *Postgres) Revoke(ctx context.Context, id string, now time.Time) (Principal, error) {
	cur, err := p.Get(ctx, id)
	if err != nil {
		return Principal{}, err
	}
	if cur.Status == StatusRevoked {
		return cur, nil
	}
	now = now.UTC()
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tag, err := p.db.Exec(ctx, `
		UPDATE machine_principals
		   SET status = 'revoked',
		       revoked_at = $2,
		       updated_at = $2
		 WHERE id = $1::uuid
		   AND status = 'active'
	`, cur.ID, now)
	if err != nil {
		return Principal{}, mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return p.Get(ctx, cur.ID)
	}
	cur.Status = StatusRevoked
	cur.RevokedAt = &now
	cur.UpdatedAt = now
	return cur.clone(), nil
}

func (p *Postgres) ConsumeJTI(ctx context.Context, jti, clientID string, retainUntil, now time.Time) error {
	if !validJTI(jti) {
		return ErrInvalid
	}
	clientID, err := NormalizeClientID(clientID)
	if err != nil {
		return err
	}
	if retainUntil.IsZero() || now.IsZero() {
		return ErrInvalid
	}
	if _, err := p.db.Exec(ctx, `DELETE FROM machine_assertion_jti WHERE retain_until <= $1`, now.UTC()); err != nil {
		return mapDBErr(err)
	}
	var got string
	err = p.db.QueryRow(ctx, `
		INSERT INTO machine_assertion_jti (jti, client_id, retain_until)
		VALUES ($1, $2, $3)
		ON CONFLICT (jti) DO NOTHING
		RETURNING jti
	`, jti, clientID, retainUntil.UTC()).Scan(&got)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrReplay
	}
	if err != nil {
		return mapDBErr(err)
	}
	return nil
}

func (p *Postgres) load(ctx context.Context, where, arg string) (Principal, error) {
	var row Principal
	var pub []byte
	err := p.db.QueryRow(ctx, `
		SELECT id::text, user_id::text, client_id, display_name, secret_hash,
		       assertion_public_key, status,
		       COALESCE(tenant_id::text, ''),
		       COALESCE(workspace_id::text, ''),
		       workbench_key,
		       created_at, updated_at, rotated_at, revoked_at
		  FROM machine_principals
		 WHERE `+where, arg).Scan(
		&row.ID, &row.UserID, &row.ClientID, &row.DisplayName, &row.secretHash,
		&pub, &row.Status, &row.TenantID, &row.WorkspaceID, &row.WorkbenchKey,
		&row.CreatedAt, &row.UpdatedAt, &row.RotatedAt, &row.RevokedAt,
	)
	if err != nil {
		return Principal{}, mapDBErr(err)
	}
	row.publicKey = pub
	grants, err := p.loadGrants(ctx, row.ID)
	if err != nil {
		return Principal{}, err
	}
	row.Grants = grants
	return row.clone(), nil
}

func (p *Postgres) loadGrants(ctx context.Context, id string) ([]string, error) {
	rows, err := p.db.Query(ctx, `
		SELECT permission_key
		  FROM machine_principal_grants
		 WHERE principal_id = $1::uuid
		 ORDER BY permission_key
	`, id)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, key)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []string{}
	}
	return out, nil
}

type execer interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
}

func insertGrants(ctx context.Context, db execer, id string, grants []string) error {
	for _, key := range grants {
		if _, err := db.Exec(ctx, `
			INSERT INTO machine_principal_grants (principal_id, permission_key)
			VALUES ($1::uuid, $2)
		`, id, key); err != nil {
			return mapDBErr(err)
		}
	}
	return nil
}

func uuidArg(s string) any {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return s
}

func mapDBErr(err error) error {
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
		case "23503":
			return ErrNotFound
		case "23514", "22P02":
			return ErrInvalid
		}
	}
	return err
}
