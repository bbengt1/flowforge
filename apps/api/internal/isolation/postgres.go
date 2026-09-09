package isolation

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
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

// Postgres persists isolation records under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed Store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Create(ctx context.Context, scope Scope, rec Record) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if !ValidKind(rec.Kind) || strings.TrimSpace(rec.Name) == "" || len(rec.Name) > 200 {
		return Record{}, ErrInvalid
	}
	rec.Metadata = StampTenancy(rec.Metadata, scope)
	meta, err := json.Marshal(rec.Metadata)
	if err != nil {
		return Record{}, ErrInvalid
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var actor any
	if scope.ActorID() != "" {
		actor = scope.ActorID()
	}
	var out Record
	var raw []byte
	err = tx.QueryRow(ctx, `
		INSERT INTO workspace_records (workspace_id, kind, name, metadata, created_by)
		VALUES ($1::uuid, $2, $3, $4::jsonb, $5::uuid)
		RETURNING workspace_id::text, id::text, kind, name, metadata, COALESCE(created_by::text, ''), created_at
	`, scope.WorkspaceID(), rec.Kind, strings.TrimSpace(rec.Name), meta, actor).Scan(
		&out.WorkspaceID, &out.ID, &out.Kind, &out.Name, &raw, &out.CreatedBy, &out.CreatedAt,
	)
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	if err := json.Unmarshal(raw, &out.Metadata); err != nil {
		out.Metadata = map[string]any{}
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope Scope, id string) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	rec, err := scanRecord(tx.QueryRow(ctx, `
		SELECT workspace_id::text, id::text, kind, name, metadata, COALESCE(created_by::text, ''), created_at
		FROM workspace_records WHERE id = $1::uuid
	`, id))
	if err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) List(ctx context.Context, scope Scope, kind string) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if kind != "" && !ValidKind(kind) {
		return nil, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT workspace_id::text, id::text, kind, name, metadata, COALESCE(created_by::text, ''), created_at
		FROM workspace_records
		WHERE ($1 = '' OR kind = $1)
		ORDER BY created_at
	`, kind)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []Record
	for rows.Next() {
		rec, err := scanRecord(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	if out == nil {
		out = []Record{}
	}
	return out, nil
}

func (p *Postgres) Link(ctx context.Context, scope Scope, parentID, kind string) (Link, error) {
	if scope.Zero() {
		return Link{}, ErrNoScope
	}
	if !ValidKind(kind) {
		return Link{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Link{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var link Link
	err = tx.QueryRow(ctx, `
		INSERT INTO workspace_record_links (workspace_id, parent_id, kind)
		VALUES ($1::uuid, $2::uuid, $3)
		RETURNING workspace_id::text, id::text, parent_id::text, kind, created_at
	`, scope.WorkspaceID(), parentID, kind).Scan(
		&link.WorkspaceID, &link.ID, &link.ParentID, &link.Kind, &link.CreatedAt,
	)
	if err != nil {
		return Link{}, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Link{}, mapDBErr(err)
	}
	return link, nil
}

func (p *Postgres) UseCredential(ctx context.Context, scope Scope, id string) error {
	rec, err := p.Get(ctx, scope, id)
	if err != nil {
		return err
	}
	if rec.Kind != KindCredential {
		return ErrNotFound
	}
	_, err = p.Create(ctx, scope, Record{
		Kind: KindAudit,
		Name: "credential.use",
		Metadata: map[string]any{
			"resource_type": "credential",
			"resource_id":   id,
			"action":        "use",
		},
	})
	return err
}

func (p *Postgres) Subscribe(ctx context.Context, scope Scope, channelID string) error {
	rec, err := p.Get(ctx, scope, channelID)
	if err != nil {
		return err
	}
	if rec.Kind != KindRealtime {
		return ErrNotFound
	}
	return nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRecord(row rowScanner) (Record, error) {
	var rec Record
	var raw []byte
	if err := row.Scan(&rec.WorkspaceID, &rec.ID, &rec.Kind, &rec.Name, &raw, &rec.CreatedBy, &rec.CreatedAt); err != nil {
		return Record{}, mapDBErr(err)
	}
	if err := json.Unmarshal(raw, &rec.Metadata); err != nil {
		rec.Metadata = map[string]any{}
	}
	return rec, nil
}

func mapDBErr(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if errors.Is(err, postgres.ErrNoWorkspaceScope) {
		return ErrNoScope
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505":
			return ErrConflict
		case "23503", "22P02", "42501":
			return ErrNotFound
		case "23514":
			return ErrInvalid
		}
	}
	return err
}
