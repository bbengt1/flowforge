package wfstore

import (
	"context"
	"errors"
	"time"

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
func workflowDeletedStepError() map[string]any {
	return map[string]any{
		"code":    ReasonWorkflowDeleted,
		"message": "Workflow was deleted.",
	}
}

// guardLiveWorkflowTx locks the live workflow row. A tombstone fails the
// execution in this transaction and returns ErrWorkflowDeleted. The caller
// must commit that stop; a rollback would undo it. The hook runs only when
// the live row is locked.
func guardLiveWorkflowTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, workflowID, executionID string) error {
	err := lockLiveWorkflow(ctx, tx, workflowID)
	if err == nil {
		return nil
	}
	if !errors.Is(err, ErrNotFound) {
		return err
	}
	if executionID != "" {
		if stopErr := stopExecutionWorkflowDeletedTx(ctx, tx, scope, now, executionID); stopErr != nil {
			return stopErr
		}
	}
	return ErrWorkflowDeleted
}

// stopExecutionWorkflowDeletedTx fails every open job and step. An already
// terminal run (other than pinned) is left as it is.
func stopExecutionWorkflowDeletedTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, executionID string) error {
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	if isTerminalExecution(exec.Status) && exec.Status != ExecutionPinned {
		return nil
	}
	errRaw, err := marshalObject(workflowDeletedStepError())
	if err != nil {
		return ErrInvalid
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		SET status = 'failed', updated_at = $2
		WHERE execution_id = $1::uuid
		  AND status IN ('blocked', 'queued', 'claimed', 'running', 'waiting')
	`, executionID, now); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'failed',
		    error_redacted = $2::jsonb,
		    finished_at = COALESCE(finished_at, $3),
		    updated_at = $3
		WHERE execution_id = $1::uuid
		  AND status IN ('pending', 'queued', 'running', 'waiting')
	`, executionID, errRaw, now); err != nil {
		return mapDBErr(err)
	}
	if err := applyExecutionStatusTx(ctx, tx, executionID, ExecutionFailed, now); err != nil {
		return err
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.stop",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonWorkflowDeleted,
		Details:      map[string]any{"reason": ReasonWorkflowDeleted},
	})
	return err
}

func (p *Postgres) AbandonIfWorkflowDeleted(ctx context.Context, scope isolation.Scope, now time.Time, executionID string) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	if err := guardLiveWorkflowTx(ctx, tx, scope, now, exec.WorkflowID, executionID); err != nil {
		if errors.Is(err, ErrWorkflowDeleted) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return mapDBErr(commitErr)
			}
			return ErrWorkflowDeleted
		}
		return err
	}
	return nil
}

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

// classifySlugViolation explains a workflows_slug_unique failure. It runs
// only after the insert was rejected, so create does not check then insert.
func classifySlugViolation(ctx context.Context, tx pgx.Tx, slug string) error {
	var deleted bool
	err := tx.QueryRow(ctx, `
		SELECT deleted_at IS NOT NULL FROM workflows WHERE slug = $1
	`, slug).Scan(&deleted)
	if err != nil {
		if errors.Is(mapDBErr(err), ErrNotFound) {
			return SlugConflict{}
		}
		return mapDBErr(err)
	}
	if deleted {
		return SlugConflict{Reserved: true}
	}
	return SlugConflict{}
}

func workflowSlugUnique(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "workflows_slug_unique"
}
