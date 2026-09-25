package wfstore

import (
	"context"
	"errors"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (p *Postgres) Delete(ctx context.Context, scope isolation.Scope, id string) (DeleteResult, error) {
	if scope.Zero() {
		return DeleteResult{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return DeleteResult{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DeleteResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	var name, status string
	var deleted bool
	err = tx.QueryRow(ctx, `
		SELECT name, status, deleted_at IS NOT NULL
		FROM workflows
		WHERE id = $1::uuid
		FOR UPDATE
	`, id).Scan(&name, &status, &deleted)
	if err != nil {
		return DeleteResult{}, mapDBErr(err)
	}
	if deleted {
		return DeleteResult{}, ErrNotFound
	}
	runWorkflowRowLockHook(ctx)

	var active bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM executions
			WHERE workflow_id = $1::uuid
			  AND status IN ('queued', 'running')
		)
	`, id).Scan(&active); err != nil {
		return DeleteResult{}, mapDBErr(err)
	}
	if active {
		return DeleteResult{}, ErrActiveExecutions
	}

	tag, err := tx.Exec(ctx, `
		UPDATE workflows
		SET status = 'draft',
		    deleted_at = now(),
		    updated_by = $2::uuid,
		    updated_at = now()
		WHERE id = $1::uuid AND deleted_at IS NULL
	`, id, actorArg(scope))
	if err != nil {
		return DeleteResult{}, mapDBErr(err)
	}
	if tag.RowsAffected() == 0 {
		return DeleteResult{}, ErrNotFound
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workflow_triggers
		SET status = 'disabled', updated_by = $2::uuid, updated_at = now()
		WHERE workflow_id = $1::uuid AND status <> 'disabled'
	`, id, actorArg(scope)); err != nil {
		return DeleteResult{}, mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE workflow_schedules
		SET status = 'disabled', updated_by = $2::uuid, updated_at = now()
		WHERE workflow_id = $1::uuid AND status <> 'disabled'
	`, id, actorArg(scope)); err != nil {
		return DeleteResult{}, mapDBErr(err)
	}

	published := status == StatusPublished
	details := map[string]any{
		"actorId":     scope.ActorID(),
		"workspaceId": scope.WorkspaceID(),
		"workflowId":  id,
		"name":        name,
		"published":   published,
	}
	if tenantID := scope.TenantID(); tenantID != "" {
		details["tenantId"] = tenantID
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "workflow.deleted",
		ResourceType: "workflow",
		ResourceID:   id,
		Outcome:      "deleted",
		Details:      details,
	}); err != nil {
		return DeleteResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DeleteResult{}, mapDBErr(err)
	}
	return DeleteResult{ID: id, Name: name, Published: published}, nil
}

// lockLiveWorkflow takes the workflow row lock used by run start.
// A missing or tombstoned row is ErrNotFound. The hook runs only after the
// live row is locked and before the caller mutates.
func lockLiveWorkflow(ctx context.Context, tx pgx.Tx, workflowID string) error {
	var id string
	err := tx.QueryRow(ctx, `
		SELECT id::text FROM workflows
		WHERE id = $1::uuid AND deleted_at IS NULL
		FOR UPDATE
	`, workflowID).Scan(&id)
	if err != nil {
		return mapDBErr(err)
	}
	runWorkflowRowLockHook(ctx)
	return nil
}

func slugClaim(ctx context.Context, tx pgx.Tx, slug string) error {
	var deleted bool
	err := tx.QueryRow(ctx, `
		SELECT deleted_at IS NOT NULL FROM workflows WHERE slug = $1
	`, slug).Scan(&deleted)
	if err != nil {
		if errors.Is(mapDBErr(err), ErrNotFound) {
			return nil
		}
		return mapDBErr(err)
	}
	if deleted {
		return ErrSlugReserved
	}
	return ErrConflict
}

func workflowSlugUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "workflows_slug_unique"
}
