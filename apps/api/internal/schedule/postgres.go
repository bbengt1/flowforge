package schedule

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const recordColumns = `
	id::text, workflow_id::text, workflow_version_id::text, workflow_digest, trigger_id,
	timezone, cron, interval, overlap_policy, misfire_policy, catch_up, status,
	next_fire_at, last_fired_at, COALESCE(last_execution_id::text, ''), last_error,
	COALESCE(created_by::text, ''), COALESCE(updated_by::text, ''), created_at, updated_at
`

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists schedules under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed schedule store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Create(ctx context.Context, scope isolation.Scope, now time.Time, in CreateInput) (Record, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	rec, err := normalizeCreate(scope, in, now)
	if err != nil {
		return Record{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	out, err := insertRecord(ctx, tx, scope, rec)
	if err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) List(ctx context.Context, scope isolation.Scope, workflowID string) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	q := `SELECT ` + recordColumns + ` FROM workflow_schedules`
	args := []any{}
	if strings.TrimSpace(workflowID) != "" {
		if !authz.ValidUUID(workflowID) {
			return []Record{}, nil
		}
		q += ` WHERE workflow_id = $1`
		args = append(args, workflowID)
	}
	q += ` ORDER BY created_at DESC`
	rows, err := tx.Query(ctx, q, args...)
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
	if out == nil {
		out = []Record{}
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Record, error) {
	if scope.Zero() {
		return Record{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return Record{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rec, err := getRecordTx(ctx, tx, id)
	if err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

func (p *Postgres) Update(ctx context.Context, scope isolation.Scope, now time.Time, id string, in UpdateInput) (Record, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	current, err := getRecordTx(ctx, tx, id)
	if err != nil {
		return Record{}, err
	}
	rec, err := applyUpdate(current, in, scope.ActorID(), now)
	if err != nil {
		return Record{}, err
	}
	out, err := updateRecord(ctx, tx, scope, rec)
	if err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) SetStatus(ctx context.Context, scope isolation.Scope, now time.Time, id, status string) (Record, error) {
	status = strings.TrimSpace(status)
	if status != StatusEnabled && status != StatusDisabled {
		return Record{}, ErrInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rec, err := getRecordTx(ctx, tx, id)
	if err != nil {
		return Record{}, err
	}
	rec.Status = status
	rec.UpdatedBy = scope.ActorID()
	rec.UpdatedAt = now.UTC()
	if status == StatusEnabled {
		next, err := NextAfter(rec, now.UTC())
		if err != nil {
			return Record{}, err
		}
		rec.NextFireAt = next
		rec.LastError = ""
	}
	out, err := updateRecord(ctx, tx, scope, rec)
	if err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Delete(ctx context.Context, scope isolation.Scope, id string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if _, err := getRecordTx(ctx, tx, id); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workflow_schedules WHERE id = $1`, id); err != nil {
		return mapDBErr(err)
	}
	return tx.Commit(ctx)
}

func (p *Postgres) ListDue(ctx context.Context, scope isolation.Scope, now time.Time) ([]Record, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT `+recordColumns+`
		FROM workflow_schedules
		WHERE status = 'enabled' AND next_fire_at <= $1
		ORDER BY next_fire_at
		FOR UPDATE SKIP LOCKED`, now.UTC())
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
	if out == nil {
		out = []Record{}
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) RecordFire(ctx context.Context, scope isolation.Scope, now time.Time, id string, in FireUpdate) (Record, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rec, err := getRecordTx(ctx, tx, id)
	if err != nil {
		return Record{}, err
	}
	if !in.NextFireAt.IsZero() {
		rec.NextFireAt = in.NextFireAt.UTC()
	}
	if in.LastFiredAt != nil {
		t := in.LastFiredAt.UTC()
		rec.LastFiredAt = &t
	}
	if strings.TrimSpace(in.LastExecutionID) != "" {
		rec.LastExecutionID = strings.TrimSpace(in.LastExecutionID)
	}
	errText := strings.TrimSpace(in.LastError)
	if len(errText) > MaxLastError {
		errText = errText[:MaxLastError]
	}
	rec.LastError = errText
	rec.UpdatedAt = now.UTC()
	out, err := updateRecord(ctx, tx, scope, rec)
	if err != nil {
		return Record{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Record{}, mapDBErr(err)
	}
	return out, nil
}

func insertRecord(ctx context.Context, tx pgx.Tx, scope isolation.Scope, rec Record) (Record, error) {
	var lastFired any
	if rec.LastFiredAt != nil {
		lastFired = *rec.LastFiredAt
	}
	var lastExec any
	if authz.ValidUUID(rec.LastExecutionID) {
		lastExec = rec.LastExecutionID
	}
	err := tx.QueryRow(ctx, `
		INSERT INTO workflow_schedules (
			workspace_id, id, workflow_id, workflow_version_id, workflow_digest, trigger_id,
			timezone, cron, interval, overlap_policy, misfire_policy, catch_up, status,
			next_fire_at, last_fired_at, last_execution_id, last_error,
			created_by, updated_by, created_at, updated_at
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6,
			$7, $8, $9, $10, $11, $12, $13,
			$14, $15, $16, $17,
			$18, $18, $19, $19
		)
		RETURNING `+recordColumns,
		scope.WorkspaceID(), rec.ID, rec.WorkflowID, rec.WorkflowVersionID, rec.WorkflowDigest, rec.TriggerID,
		rec.Timezone, rec.Cron, rec.Interval, rec.OverlapPolicy, rec.MisfirePolicy, rec.CatchUp, rec.Status,
		rec.NextFireAt, lastFired, lastExec, rec.LastError,
		actorArg(scope), rec.CreatedAt,
	).Scan(scanDest(&rec)...)
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	return rec, nil
}

func updateRecord(ctx context.Context, tx pgx.Tx, scope isolation.Scope, rec Record) (Record, error) {
	var lastFired any
	if rec.LastFiredAt != nil {
		lastFired = *rec.LastFiredAt
	}
	var lastExec any
	if authz.ValidUUID(rec.LastExecutionID) {
		lastExec = rec.LastExecutionID
	}
	err := tx.QueryRow(ctx, `
		UPDATE workflow_schedules SET
			workflow_version_id = $2::uuid,
			workflow_digest = $3,
			trigger_id = $4,
			timezone = $5,
			cron = $6,
			interval = $7,
			overlap_policy = $8,
			misfire_policy = $9,
			catch_up = $10,
			status = $11,
			next_fire_at = $12,
			last_fired_at = $13,
			last_execution_id = $14,
			last_error = $15,
			updated_by = $16,
			updated_at = $17
		WHERE id = $1::uuid
		RETURNING `+recordColumns,
		rec.ID, rec.WorkflowVersionID, rec.WorkflowDigest, rec.TriggerID,
		rec.Timezone, rec.Cron, rec.Interval, rec.OverlapPolicy, rec.MisfirePolicy, rec.CatchUp, rec.Status,
		rec.NextFireAt, lastFired, lastExec, rec.LastError, actorArg(scope), rec.UpdatedAt,
	).Scan(scanDest(&rec)...)
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	_ = scope
	return rec, nil
}

func getRecordTx(ctx context.Context, tx pgx.Tx, id string) (Record, error) {
	return scanRecord(tx.QueryRow(ctx, `SELECT `+recordColumns+` FROM workflow_schedules WHERE id = $1::uuid`, id))
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanRecord(row rowScanner) (Record, error) {
	var rec Record
	var lastFired *time.Time
	err := row.Scan(
		&rec.ID, &rec.WorkflowID, &rec.WorkflowVersionID, &rec.WorkflowDigest, &rec.TriggerID,
		&rec.Timezone, &rec.Cron, &rec.Interval, &rec.OverlapPolicy, &rec.MisfirePolicy, &rec.CatchUp, &rec.Status,
		&rec.NextFireAt, &lastFired, &rec.LastExecutionID, &rec.LastError,
		&rec.CreatedBy, &rec.UpdatedBy, &rec.CreatedAt, &rec.UpdatedAt,
	)
	if err != nil {
		return Record{}, mapDBErr(err)
	}
	rec.LastFiredAt = lastFired
	return rec, nil
}

func scanDest(rec *Record) []any {
	return []any{
		&rec.ID, &rec.WorkflowID, &rec.WorkflowVersionID, &rec.WorkflowDigest, &rec.TriggerID,
		&rec.Timezone, &rec.Cron, &rec.Interval, &rec.OverlapPolicy, &rec.MisfirePolicy, &rec.CatchUp, &rec.Status,
		&rec.NextFireAt, &rec.LastFiredAt, &rec.LastExecutionID, &rec.LastError,
		&rec.CreatedBy, &rec.UpdatedBy, &rec.CreatedAt, &rec.UpdatedAt,
	}
}

func actorArg(scope isolation.Scope) any {
	if scope.ActorID() == "" {
		return nil
	}
	return scope.ActorID()
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
		case "23503", "23514":
			return ErrInvalid
		}
	}
	return err
}
