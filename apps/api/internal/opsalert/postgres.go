package opsalert

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const alertColumns = `
	id::text, kind, severity, action, resource_type,
	COALESCE(resource_id::text, ''), COALESCE(correlation_id, ''),
	COALESCE(request_id, ''), COALESCE(actor_id::text, ''),
	outcome, code, details_redacted,
	acknowledged_at, COALESCE(acknowledged_by::text, ''), occurred_at
`

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists alerts under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed alert store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

// Emit sanitizes and inserts an alert.
func (p *Postgres) Emit(ctx context.Context, scope isolation.Scope, in Signal) (Alert, error) {
	if scope.Zero() {
		return Alert{}, ErrNoScope
	}
	alert, err := prepareAlert(scope, in, time.Now().UTC())
	if err != nil {
		return Alert{}, err
	}
	detailsRaw, err := json.Marshal(alert.Details)
	if err != nil {
		return Alert{}, ErrInvalid
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Alert{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	row := tx.QueryRow(ctx, `
		INSERT INTO operational_alerts (
			workspace_id, id, kind, severity, action, resource_type, resource_id,
			correlation_id, request_id, actor_id, outcome, code, details_redacted, occurred_at
		) VALUES (
			$1::uuid, $2::uuid, $3, $4, $5, $6, NULLIF($7, '')::uuid,
			NULLIF($8, ''), NULLIF($9, ''), NULLIF($10, '')::uuid, $11, $12, $13::jsonb, $14
		)
		RETURNING `+alertColumns,
		scope.WorkspaceID(), alert.ID, alert.Kind, alert.Severity, alert.Action, alert.ResourceType,
		alert.ResourceID, alert.CorrelationID, alert.RequestID, alert.ActorID, alert.Outcome, alert.Code,
		detailsRaw, alert.OccurredAt,
	)
	out, err := scanAlert(row)
	if err != nil {
		return Alert{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Alert{}, mapDBErr(err)
	}
	return out, nil
}

// List returns newest-first alerts for the scoped workspace.
func (p *Postgres) List(ctx context.Context, scope isolation.Scope, filter ListFilter) ([]Alert, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if filter.ResourceID != "" && sanitizeID(filter.ResourceID) == "" {
		return nil, ErrNotFound
	}
	status := strings.TrimSpace(filter.Status)
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT `+alertColumns+`
		FROM operational_alerts
		WHERE ($1 = '' OR kind = $1)
		  AND ($2 = '' OR resource_type = $2)
		  AND ($3 = '' OR resource_id = $3::uuid)
		  AND ($4 = '' OR ($4 = 'open' AND acknowledged_at IS NULL) OR ($4 = 'acked' AND acknowledged_at IS NOT NULL))
		ORDER BY occurred_at DESC
		LIMIT $5
	`, strings.TrimSpace(filter.Kind), strings.TrimSpace(filter.ResourceType),
		sanitizeID(filter.ResourceID), status, listLimit(filter.Limit))
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []Alert{}
	for rows.Next() {
		alert, err := scanAlert(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, alert)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

// Get returns one alert or ErrNotFound.
func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Alert, error) {
	if scope.Zero() {
		return Alert{}, ErrNoScope
	}
	id = sanitizeID(id)
	if id == "" {
		return Alert{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Alert{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	alert, err := scanAlert(tx.QueryRow(ctx, `SELECT `+alertColumns+` FROM operational_alerts WHERE id = $1::uuid`, id))
	if err != nil {
		return Alert{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Alert{}, mapDBErr(err)
	}
	return alert, nil
}

// Ack marks an alert acknowledged. Repeat acks are idempotent.
func (p *Postgres) Ack(ctx context.Context, scope isolation.Scope, id string) (Alert, error) {
	if scope.Zero() {
		return Alert{}, ErrNoScope
	}
	id = sanitizeID(id)
	if id == "" {
		return Alert{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Alert{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	alert, err := scanAlert(tx.QueryRow(ctx, `
		UPDATE operational_alerts
		SET acknowledged_at = COALESCE(acknowledged_at, now()),
		    acknowledged_by = COALESCE(acknowledged_by, NULLIF($2, '')::uuid)
		WHERE id = $1::uuid
		RETURNING `+alertColumns, id, scope.ActorID()))
	if err != nil {
		return Alert{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Alert{}, mapDBErr(err)
	}
	return alert, nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanAlert(row scanner) (Alert, error) {
	var (
		a          Alert
		detailsRaw []byte
		ackedAt    *time.Time
	)
	err := row.Scan(
		&a.ID, &a.Kind, &a.Severity, &a.Action, &a.ResourceType,
		&a.ResourceID, &a.CorrelationID, &a.RequestID, &a.ActorID,
		&a.Outcome, &a.Code, &detailsRaw, &ackedAt, &a.AcknowledgedBy, &a.OccurredAt,
	)
	if err != nil {
		return Alert{}, mapDBErr(err)
	}
	a.AcknowledgedAt = ackedAt
	a.Details = map[string]any{}
	if len(detailsRaw) > 0 {
		_ = json.Unmarshal(detailsRaw, &a.Details)
	}
	return a, nil
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
			return ErrInvalid
		case "23503", "22P02", "42501":
			return ErrNotFound
		case "23514":
			return ErrInvalid
		}
	}
	return err
}
