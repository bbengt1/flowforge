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

	openIDs, err := openExecutionIDsTx(ctx, tx, id)
	if err != nil {
		return DeleteResult{}, err
	}
	// Workflow row is already locked. Execution rows follow, sorted, before
	// any job, step, or approval update. That matches the workflow-first
	// order used by claim recovery and resume.
	if err := lockExecutionsSorted(ctx, tx, openIDs); err != nil {
		return DeleteResult{}, err
	}
	runs, err := loadOpenRunsTx(ctx, tx, openIDs)
	if err != nil {
		return DeleteResult{}, err
	}
	impact, parked := classifyDeleteRuns(runs)
	if impact.Blocked {
		return DeleteResult{}, ErrActiveExecutions
	}
	now := time.Now().UTC()
	for _, executionID := range parked {
		if err := closeParkedRunTx(ctx, tx, scope, now, executionID); err != nil {
			return DeleteResult{}, err
		}
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

// DeleteImpact classifies open runs with the same function Delete uses.
// It does not lock or change rows.
func (p *Postgres) DeleteImpact(ctx context.Context, scope isolation.Scope, id string) (DeleteImpact, error) {
	if scope.Zero() {
		return DeleteImpact{}, ErrNoScope
	}
	if !authz.ValidUUID(id) {
		return DeleteImpact{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DeleteImpact{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	var deleted bool
	err = tx.QueryRow(ctx, `
		SELECT deleted_at IS NOT NULL FROM workflows WHERE id = $1::uuid
	`, id).Scan(&deleted)
	if err != nil {
		return DeleteImpact{}, mapDBErr(err)
	}
	if deleted {
		return DeleteImpact{}, ErrNotFound
	}
	openIDs, err := openExecutionIDsTx(ctx, tx, id)
	if err != nil {
		return DeleteImpact{}, err
	}
	runs, err := loadOpenRunsTx(ctx, tx, openIDs)
	if err != nil {
		return DeleteImpact{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DeleteImpact{}, mapDBErr(err)
	}
	impact, _ := classifyDeleteRuns(runs)
	return impact, nil
}

func openExecutionIDsTx(ctx context.Context, tx pgx.Tx, workflowID string) ([]string, error) {
	rows, err := tx.Query(ctx, `
		SELECT id::text FROM executions
		WHERE workflow_id = $1::uuid
		  AND status IN ('queued', 'running', 'waiting')
		ORDER BY id
	`, workflowID)
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
	return ids, nil
}

func loadOpenRunsTx(ctx context.Context, tx pgx.Tx, ids []string) ([]openRun, error) {
	runs := make([]openRun, 0, len(ids))
	for _, id := range ids {
		exec, err := getExecutionTx(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		steps, err := loadStepsTx(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		jobs, err := loadJobsTx(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		runs = append(runs, openRun{id: id, jobs: jobs, steps: steps, status: exec.Status})
	}
	return runs, nil
}

// closeParkedRunTx fails one run that has no job in flight. Waiting, pending,
// and blocked steps and jobs become canceled with workflow_deleted, which
// also cancels a flow.delay timer (the waiting job). The run ends failed,
// the same terminal state as a resume that finds the workflow gone, so the
// concurrency slot is free. Pending approvals close in this transaction.
func closeParkedRunTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, executionID string) error {
	errRaw, err := marshalObject(workflowDeletedStepError())
	if err != nil {
		return ErrInvalid
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		SET status = 'canceled',
		    worker_id = NULL,
		    lease_expires_at = NULL,
		    available_at = $2,
		    updated_at = $2
		WHERE execution_id = $1::uuid
		  AND status IN ('waiting', 'pending', 'blocked')
	`, executionID, now); err != nil {
		return mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'canceled',
		    error_redacted = $2::jsonb,
		    finished_at = COALESCE(finished_at, $3),
		    updated_at = $3
		WHERE execution_id = $1::uuid
		  AND status IN ('waiting', 'pending', 'blocked')
	`, executionID, errRaw, now); err != nil {
		return mapDBErr(err)
	}
	if err := applyExecutionStatusTx(ctx, tx, executionID, ExecutionFailed, now); err != nil {
		return err
	}
	closed, err := closePendingApprovalsTx(ctx, tx, executionID, ReasonWorkflowDeleted, now)
	if err != nil {
		return err
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.stop",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonWorkflowDeleted,
		Details:      map[string]any{"reason": ReasonWorkflowDeleted, "approvalsClosed": closed},
	})
	return err
}

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
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return err
	}
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
	closed, err := closePendingApprovalsTx(ctx, tx, executionID, ReasonWorkflowDeleted, now)
	if err != nil {
		return err
	}
	_, err = insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.stop",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      ReasonWorkflowDeleted,
		Details:      map[string]any{"reason": ReasonWorkflowDeleted, "approvalsClosed": closed},
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
