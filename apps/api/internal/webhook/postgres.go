package webhook

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

const triggerColumns = `
	id::text, public_id, workflow_id::text, workflow_version_id::text, type, status,
	secret_credential_id::text, content_type, field_mapping,
	max_body_bytes, clock_skew_seconds, replay_retention_seconds,
	rate_limit_per_minute, workspace_rate_per_minute, max_concurrency, workspace_max_concurrency,
	COALESCE(created_by::text, ''), COALESCE(updated_by::text, ''), created_at, updated_at
`

// DB is the subset of pgx used by Postgres.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Postgres persists webhook triggers under FORCE RLS.
type Postgres struct {
	db DB
}

// NewPostgres returns a PostgreSQL-backed webhook store.
func NewPostgres(db DB) *Postgres {
	return &Postgres{db: db}
}

func (p *Postgres) Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Trigger, error) {
	trig, err := normalizeCreate(scope, in, time.Now().UTC())
	if err != nil {
		return Trigger{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Trigger{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	out, err := insertTrigger(ctx, tx, scope, trig)
	if err != nil {
		return Trigger{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Trigger{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) List(ctx context.Context, scope isolation.Scope, workflowID string) ([]Trigger, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	q := `SELECT ` + triggerColumns + ` FROM workflow_triggers`
	args := []any{}
	if strings.TrimSpace(workflowID) != "" {
		if !authz.ValidUUID(workflowID) {
			return []Trigger{}, nil
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
	var out []Trigger
	for rows.Next() {
		trig, err := scanTrigger(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, trig)
	}
	if out == nil {
		out = []Trigger{}
	}
	return out, rows.Err()
}

func (p *Postgres) Get(ctx context.Context, scope isolation.Scope, id string) (Trigger, error) {
	if scope.Zero() {
		return Trigger{}, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Trigger{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	trig, err := getTriggerTx(ctx, tx, id)
	if err != nil {
		return Trigger{}, err
	}
	return trig, nil
}

func (p *Postgres) Update(ctx context.Context, scope isolation.Scope, id string, in UpdateInput) (Trigger, error) {
	if scope.Zero() {
		return Trigger{}, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Trigger{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	current, err := getTriggerTx(ctx, tx, id)
	if err != nil {
		return Trigger{}, err
	}
	updated, err := applyUpdate(current, in, scope.ActorID(), time.Now().UTC())
	if err != nil {
		return Trigger{}, err
	}
	mapping, err := json.Marshal(updated.FieldMapping)
	if err != nil {
		return Trigger{}, ErrInvalid
	}
	row := tx.QueryRow(ctx, `UPDATE workflow_triggers SET
		workflow_version_id = $2, secret_credential_id = $3, content_type = $4, field_mapping = $5::jsonb,
		max_body_bytes = $6, clock_skew_seconds = $7, replay_retention_seconds = $8,
		rate_limit_per_minute = $9, workspace_rate_per_minute = $10, max_concurrency = $11,
		workspace_max_concurrency = $12, updated_by = NULLIF($13, '')::uuid, updated_at = $14
		WHERE id = $1
		RETURNING `+triggerColumns,
		updated.ID, updated.WorkflowVersionID, updated.SecretCredentialID, updated.ContentType, mapping,
		updated.MaxBodyBytes, updated.ClockSkewSeconds, updated.ReplayRetentionSeconds,
		updated.RateLimitPerMinute, updated.WorkspaceRatePerMinute, updated.MaxConcurrency,
		updated.WorkspaceMaxConcurrency, updated.UpdatedBy, updated.UpdatedAt)
	out, err := scanTrigger(row)
	if err != nil {
		return Trigger{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Trigger{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) SetStatus(ctx context.Context, scope isolation.Scope, id, status string) (Trigger, error) {
	status = strings.TrimSpace(status)
	if status != StatusEnabled && status != StatusDisabled {
		return Trigger{}, ErrInvalid
	}
	if scope.Zero() {
		return Trigger{}, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Trigger{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	current, err := getTriggerTx(ctx, tx, id)
	if err != nil {
		return Trigger{}, err
	}
	row := tx.QueryRow(ctx, `UPDATE workflow_triggers SET status = $2, updated_by = NULLIF($3, '')::uuid, updated_at = $4
		WHERE id = $1 RETURNING `+triggerColumns, current.ID, status, scope.ActorID(), time.Now().UTC())
	out, err := scanTrigger(row)
	if err != nil {
		return Trigger{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Trigger{}, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) Delete(ctx context.Context, scope isolation.Scope, id string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	current, err := getTriggerTx(ctx, tx, id)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM workflow_triggers WHERE id = $1`, current.ID); err != nil {
		return mapDBErr(err)
	}
	return tx.Commit(ctx)
}

func (p *Postgres) LookupPublic(ctx context.Context, publicID string) (string, Trigger, error) {
	publicID = strings.TrimSpace(publicID)
	if !publicIDLooksValid(publicID) {
		return "", Trigger{}, ErrNotFound
	}
	var workspaceID *string
	if err := p.db.QueryRow(ctx, `SELECT app.lookup_webhook_workspace($1)::text`, publicID).Scan(&workspaceID); err != nil {
		return "", Trigger{}, mapDBErr(err)
	}
	if workspaceID == nil || !authz.ValidUUID(*workspaceID) {
		return "", Trigger{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, *workspaceID)
	if err != nil {
		return "", Trigger{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	trig, err := getTriggerTx(ctx, tx, publicID)
	if err != nil {
		return "", Trigger{}, err
	}
	return *workspaceID, trig, nil
}

func (p *Postgres) AcquireDelivery(ctx context.Context, scope isolation.Scope, triggerID string, now time.Time, limits DeliveryLimits) error {
	if scope.Zero() {
		return ErrNoScope
	}
	now = now.UTC()
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	trig, err := getTriggerTx(ctx, tx, triggerID)
	if err != nil {
		return err
	}
	if trig.Status != StatusEnabled {
		return ErrDisabled
	}
	if _, err := tx.Exec(ctx, `DELETE FROM webhook_replays WHERE expires_at <= $1`, now); err != nil {
		return mapDBErr(err)
	}
	retention := limits.ReplayRetention
	if retention <= 0 {
		retention = time.Duration(trig.ReplayRetentionSeconds) * time.Second
	}
	tag, err := tx.Exec(ctx, `INSERT INTO webhook_replays (workspace_id, trigger_id, replay_id, expires_at)
		VALUES (app.current_workspace_id(), $1, $2, $3)
		ON CONFLICT (workspace_id, trigger_id, replay_id) DO NOTHING`, trig.ID, limits.ReplayID, now.Add(retention))
	if err != nil {
		return mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return ErrReplay
	}
	window := now.Truncate(time.Minute)
	if err := bumpWindow(ctx, tx, "trigger", trig.ID, window, limits.RateLimitPerMinute, limits.MaxConcurrency); err != nil {
		return err
	}
	if err := bumpWindow(ctx, tx, "workspace", scope.WorkspaceID(), window, limits.WorkspaceRatePerMinute, limits.WorkspaceMaxConcurrency); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *Postgres) ReleaseDelivery(ctx context.Context, scope isolation.Scope, triggerID string, now time.Time) {
	if scope.Zero() {
		return
	}
	now = now.UTC()
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return
	}
	defer tx.Rollback(ctx)
	trig, err := getTriggerTx(ctx, tx, triggerID)
	if err != nil {
		return
	}
	window := now.Truncate(time.Minute)
	_, _ = tx.Exec(ctx, `UPDATE webhook_rate_windows SET in_flight = GREATEST(in_flight - 1, 0)
		WHERE scope_kind = 'trigger' AND scope_id = $1 AND window_start = $2`, trig.ID, window)
	_, _ = tx.Exec(ctx, `UPDATE webhook_rate_windows SET in_flight = GREATEST(in_flight - 1, 0)
		WHERE scope_kind = 'workspace' AND scope_id = $1 AND window_start = $2`, scope.WorkspaceID(), window)
	_ = tx.Commit(ctx)
}

func (p *Postgres) FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]wfstore.CredentialRef, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if !authz.ValidUUID(credentialID) {
		return []wfstore.CredentialRef{}, nil
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT workflow_id::text, public_id, workflow_version_id::text
		FROM workflow_triggers WHERE secret_credential_id = $1`, credentialID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []wfstore.CredentialRef
	for rows.Next() {
		var ref wfstore.CredentialRef
		if err := rows.Scan(&ref.WorkflowID, &ref.WorkflowSlug, &ref.VersionID); err != nil {
			return nil, err
		}
		ref.Kind = wfstore.CredentialRefTrigger
		ref.WorkflowName = "webhook"
		out = append(out, ref)
	}
	if out == nil {
		out = []wfstore.CredentialRef{}
	}
	return out, rows.Err()
}

func bumpWindow(ctx context.Context, tx pgx.Tx, kind, scopeID string, window time.Time, rateLimit, maxConc int) error {
	var count, inFlight int
	err := tx.QueryRow(ctx, `INSERT INTO webhook_rate_windows (workspace_id, scope_kind, scope_id, window_start, count, in_flight)
		VALUES (app.current_workspace_id(), $1, $2, $3, 1, 1)
		ON CONFLICT (workspace_id, scope_kind, scope_id, window_start)
		DO UPDATE SET count = webhook_rate_windows.count + 1, in_flight = webhook_rate_windows.in_flight + 1
		RETURNING count, in_flight`, kind, scopeID, window).Scan(&count, &inFlight)
	if err != nil {
		return mapDBErr(err)
	}
	if rateLimit > 0 && count > rateLimit {
		return ErrRateLimited
	}
	if maxConc > 0 && inFlight > maxConc {
		return ErrConcurrency
	}
	return nil
}

func insertTrigger(ctx context.Context, tx pgx.Tx, scope isolation.Scope, trig Trigger) (Trigger, error) {
	mapping, err := json.Marshal(trig.FieldMapping)
	if err != nil {
		return Trigger{}, ErrInvalid
	}
	row := tx.QueryRow(ctx, `INSERT INTO workflow_triggers (
		workspace_id, id, public_id, workflow_id, workflow_version_id, type, status,
		secret_credential_id, content_type, field_mapping, max_body_bytes, clock_skew_seconds,
		replay_retention_seconds, rate_limit_per_minute, workspace_rate_per_minute,
		max_concurrency, workspace_max_concurrency, created_by, updated_by, created_at, updated_at
	) VALUES (
		app.current_workspace_id(), $1::uuid, $2, $3::uuid, $4::uuid, $5, $6,
		$7::uuid, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16,
		NULLIF($17, '')::uuid, NULLIF($18, '')::uuid, $19, $20
	) RETURNING `+triggerColumns,
		trig.ID, trig.PublicID, trig.WorkflowID, trig.WorkflowVersionID, trig.Type, trig.Status,
		trig.SecretCredentialID, trig.ContentType, mapping, trig.MaxBodyBytes, trig.ClockSkewSeconds,
		trig.ReplayRetentionSeconds, trig.RateLimitPerMinute, trig.WorkspaceRatePerMinute,
		trig.MaxConcurrency, trig.WorkspaceMaxConcurrency, trig.CreatedBy, trig.UpdatedBy,
		trig.CreatedAt, trig.UpdatedAt)
	out, err := scanTrigger(row)
	if err != nil {
		return Trigger{}, err
	}
	_ = scope
	return out, nil
}

func getTriggerTx(ctx context.Context, tx pgx.Tx, id string) (Trigger, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Trigger{}, ErrNotFound
	}
	var row pgx.Row
	if publicIDLooksValid(id) {
		row = tx.QueryRow(ctx, `SELECT `+triggerColumns+` FROM workflow_triggers WHERE public_id = $1`, id)
	} else if authz.ValidUUID(id) {
		row = tx.QueryRow(ctx, `SELECT `+triggerColumns+` FROM workflow_triggers WHERE id = $1`, id)
	} else {
		return Trigger{}, ErrNotFound
	}
	return scanTrigger(row)
}

type scanner interface {
	Scan(dest ...any) error
}

func scanTrigger(row scanner) (Trigger, error) {
	var trig Trigger
	var mapping []byte
	if err := row.Scan(
		&trig.ID, &trig.PublicID, &trig.WorkflowID, &trig.WorkflowVersionID, &trig.Type, &trig.Status,
		&trig.SecretCredentialID, &trig.ContentType, &mapping,
		&trig.MaxBodyBytes, &trig.ClockSkewSeconds, &trig.ReplayRetentionSeconds,
		&trig.RateLimitPerMinute, &trig.WorkspaceRatePerMinute, &trig.MaxConcurrency, &trig.WorkspaceMaxConcurrency,
		&trig.CreatedBy, &trig.UpdatedBy, &trig.CreatedAt, &trig.UpdatedAt,
	); err != nil {
		return Trigger{}, mapDBErr(err)
	}
	if len(mapping) > 0 {
		_ = json.Unmarshal(mapping, &trig.FieldMapping)
	}
	if trig.FieldMapping == nil {
		trig.FieldMapping = map[string]string{}
	}
	trig.IngressPath = IngressPathFor(trig.PublicID)
	return trig, nil
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
		switch pgErr.ConstraintName {
		case "workflow_triggers_public_id_uidx", "workflow_triggers_public_id_format":
			return ErrConflict
		case "workflow_triggers_workflow_fk", "workflow_triggers_version_fk":
			return ErrUnpublished
		case "workflow_triggers_secret_fk":
			return ErrInvalid
		}
		if pgErr.Code == "23505" {
			return ErrConflict
		}
		if pgErr.Code == "23503" {
			return ErrInvalid
		}
	}
	return err
}
