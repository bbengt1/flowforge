package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

const executionColumns = `
	e.id::text,
	e.workflow_id::text,
	COALESCE(w.slug, ''),
	COALESCE(w.name, ''),
	e.workflow_version_id::text,
	e.workflow_digest,
	COALESCE(e.trigger_id::text, ''),
	e.status,
	COALESCE(e.idempotency_key, ''),
	e.input_redacted,
	e.policy_snapshot,
	COALESCE(e.correlation_id, ''),
	COALESCE(e.requested_by::text, ''),
	e.created_at,
	e.started_at,
	e.finished_at,
	COALESCE(e.updated_at, e.created_at),
	e.retention_until,
	COALESCE(e.idempotency_fingerprint, '')
`

const executionInsertReturning = `
	id::text,
	workflow_id::text,
	COALESCE((SELECT slug FROM workflows WHERE id = workflow_id), ''),
	COALESCE((SELECT name FROM workflows WHERE id = workflow_id), ''),
	workflow_version_id::text,
	workflow_digest,
	COALESCE(trigger_id::text, ''),
	status,
	COALESCE(idempotency_key, ''),
	input_redacted,
	policy_snapshot,
	COALESCE(correlation_id, ''),
	COALESCE(requested_by::text, ''),
	created_at,
	started_at,
	finished_at,
	COALESCE(updated_at, created_at),
	retention_until,
	COALESCE(idempotency_fingerprint, '')
`

func (p *Postgres) PeekIdempotent(ctx context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error) {
	prepared, err := prepareStart(scope, workflowID, in)
	if err != nil {
		return Execution{}, err
	}
	if prepared.key == "" {
		return Execution{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Execution{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if _, err := scanVersion(tx.QueryRow(ctx, getVersionSQL, workflowID, in.VersionID)); err != nil {
		return Execution{}, err
	}
	existing, found, err := lookupIdempotentTx(ctx, tx, workflowID, in.VersionID, prepared.key)
	if err != nil {
		return Execution{}, err
	}
	if !found {
		return Execution{}, ErrNotFound
	}
	if existing.fingerprint != prepared.fingerprint {
		return Execution{}, ErrIdempotencyConflict
	}
	existing.Replayed = true
	if err := tx.Commit(ctx); err != nil {
		return Execution{}, mapDBErr(err)
	}
	return existing, nil
}

func (p *Postgres) GetExecutionByID(ctx context.Context, scope isolation.Scope, executionID string) (Execution, error) {
	if scope.Zero() {
		return Execution{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return Execution{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Execution{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	exec, err := scanExecution(tx.QueryRow(ctx, `
		SELECT `+executionColumns+`
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE e.id = $1::uuid
	`, executionID))
	if err != nil {
		return Execution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Execution{}, mapDBErr(err)
	}
	return exec, nil
}

func (p *Postgres) ListExecutions(ctx context.Context, scope isolation.Scope, filter ExecutionListFilter) ([]Execution, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if filter.WorkflowID != "" && !authz.ValidUUID(filter.WorkflowID) {
		return nil, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if filter.WorkflowID != "" {
		if err := requireWorkflow(ctx, tx, filter.WorkflowID); err != nil {
			return nil, err
		}
	}
	rows, err := tx.Query(ctx, `
		SELECT `+executionColumns+`
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE ($1 = '' OR e.workflow_id = $1::uuid)
		  AND ($2 = '' OR e.status = $2)
		ORDER BY e.started_at DESC NULLS LAST, e.created_at DESC
		LIMIT $3
	`, filter.WorkflowID, strings.TrimSpace(filter.Status), listLimit(filter.Limit))
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []Execution{}
	for rows.Next() {
		exec, err := scanExecution(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, exec)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) ListSteps(ctx context.Context, scope isolation.Scope, executionID string) ([]ExecutionStep, error) {
	if _, err := p.GetExecutionByID(ctx, scope, executionID); err != nil {
		return nil, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT `+stepColumns+`
		FROM execution_steps
		WHERE execution_id = $1::uuid
		ORDER BY created_at, node_id
	`, executionID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []ExecutionStep{}
	for rows.Next() {
		step, err := scanStep(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, step)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) GetStep(ctx context.Context, scope isolation.Scope, executionID, stepID string) (ExecutionStep, error) {
	if !authz.ValidUUID(executionID) || !authz.ValidUUID(stepID) {
		return ExecutionStep{}, ErrNotFound
	}
	if _, err := p.GetExecutionByID(ctx, scope, executionID); err != nil {
		return ExecutionStep{}, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return ExecutionStep{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	step, err := scanStep(tx.QueryRow(ctx, `
		SELECT `+stepColumns+`
		FROM execution_steps
		WHERE execution_id = $1::uuid AND id = $2::uuid
	`, executionID, stepID))
	if err != nil {
		return ExecutionStep{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ExecutionStep{}, mapDBErr(err)
	}
	return step, nil
}

func (p *Postgres) ListJobs(ctx context.Context, scope isolation.Scope, executionID string) ([]ExecutionJob, error) {
	if _, err := p.GetExecutionByID(ctx, scope, executionID); err != nil {
		return nil, err
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT `+jobColumns+`
		FROM execution_jobs
		WHERE execution_id = $1::uuid
		ORDER BY created_at
	`, executionID)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []ExecutionJob{}
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, job)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) ListAuditEvents(ctx context.Context, scope isolation.Scope, filter AuditListFilter) ([]AuditEvent, error) {
	if scope.Zero() {
		return nil, ErrNoScope
	}
	if filter.ResourceID != "" && !authz.ValidUUID(filter.ResourceID) {
		return nil, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `
		SELECT `+auditColumns+`
		FROM audit_events
		WHERE ($1 = '' OR resource_type = $1)
		  AND ($2 = '' OR resource_id = $2::uuid)
		  AND ($3 = '' OR action = $3)
		ORDER BY occurred_at DESC
		LIMIT $4
	`, strings.TrimSpace(filter.ResourceType), strings.TrimSpace(filter.ResourceID), strings.TrimSpace(filter.Action), listLimit(filter.Limit))
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	out := []AuditEvent{}
	for rows.Next() {
		ev, err := scanAudit(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ev)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func (p *Postgres) WriteAudit(ctx context.Context, scope isolation.Scope, in AuditWrite) (AuditEvent, error) {
	if scope.Zero() {
		return AuditEvent{}, ErrNoScope
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return AuditEvent{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	ev, err := insertAuditTx(ctx, tx, scope, in)
	if err != nil {
		return AuditEvent{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AuditEvent{}, mapDBErr(err)
	}
	return ev, nil
}

func (p *Postgres) PurgeExpired(ctx context.Context, scope isolation.Scope, now time.Time) (int, int, error) {
	if scope.Zero() {
		return 0, 0, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return 0, 0, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	tag, err := tx.Exec(ctx, `
		DELETE FROM executions e
		WHERE e.retention_until <= $1
		  AND e.status IN ('queued', 'pinned', 'succeeded', 'failed', 'canceled', 'indeterminate')
		  AND NOT EXISTS (
			SELECT 1 FROM execution_artifacts a
			WHERE a.workspace_id = e.workspace_id
			  AND a.execution_id = e.id
			  AND a.legal_hold = true
		  )
	`, now)
	if err != nil {
		return 0, 0, mapDBErr(err)
	}
	execs := int(tag.RowsAffected())
	tag, err = tx.Exec(ctx, `DELETE FROM audit_events WHERE retention_until <= $1`, now)
	if err != nil {
		return 0, 0, mapDBErr(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, 0, mapDBErr(err)
	}
	return execs, int(tag.RowsAffected()), nil
}

func lookupIdempotentTx(ctx context.Context, tx pgx.Tx, workflowID, versionID, key string) (Execution, bool, error) {
	exec, err := scanExecution(tx.QueryRow(ctx, `
		SELECT `+executionColumns+`
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE e.workflow_id = $1::uuid
		  AND e.workflow_version_id = $2::uuid
		  AND e.idempotency_key = $3
		FOR UPDATE OF e
	`, workflowID, versionID, key))
	if err != nil {
		if err == ErrNotFound {
			return Execution{}, false, nil
		}
		return Execution{}, false, err
	}
	return exec, true, nil
}

func insertPlanTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, executionID string, nodes []plannedNode) error {
	now := time.Now().UTC()
	steps, jobs := materializePlan(executionID, nodes, now)
	for _, step := range steps {
		inputRaw, err := marshalObject(step.Input)
		if err != nil {
			return ErrInvalid
		}
		_, err = tx.Exec(ctx, `
			INSERT INTO execution_steps (
				workspace_id, id, execution_id, node_id, node_type, attempt, status,
				input_redacted, created_at, updated_at
			) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9, $9)
		`, scope.WorkspaceID(), step.ID, executionID, step.NodeID, step.NodeType, step.Attempt, step.Status, inputRaw, now)
		if err != nil {
			return mapDBErr(err)
		}
	}
	for _, job := range jobs {
		_, err := tx.Exec(ctx, `
			INSERT INTO execution_jobs (
				workspace_id, id, execution_id, execution_step_id, status, available_at, attempt, created_at, updated_at
			) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $6, $6)
		`, scope.WorkspaceID(), job.ID, executionID, job.ExecutionStepID, job.Status, now, job.Attempt)
		if err != nil {
			return mapDBErr(err)
		}
	}
	return nil
}

func insertAuditTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, in AuditWrite) (AuditEvent, error) {
	ev := newAudit(scope, in, time.Now().UTC())
	if ev.Action == "" || ev.ResourceType == "" || ev.Outcome == "" {
		return AuditEvent{}, ErrInvalid
	}
	hostRaw, err := marshalObject(ev.HostContext)
	if err != nil {
		return AuditEvent{}, ErrInvalid
	}
	detailsRaw, err := marshalObject(ev.Details)
	if err != nil {
		return AuditEvent{}, ErrInvalid
	}
	err = tx.QueryRow(ctx, `
		INSERT INTO audit_events (
			workspace_id, id, actor_id, host_context_redacted, action, resource_type,
			resource_id, outcome, correlation_id, details_redacted, occurred_at, retention_until
		) VALUES (
			$1::uuid, $2::uuid, $3::uuid, $4::jsonb, $5, $6,
			NULLIF($7, '')::uuid, $8, NULLIF($9, ''), $10::jsonb, $11, $12
		)
		RETURNING `+auditColumns, scope.WorkspaceID(), ev.ID, actorArg(scope), hostRaw, ev.Action, ev.ResourceType,
		ev.ResourceID, ev.Outcome, ev.CorrelationID, detailsRaw, ev.OccurredAt, ev.RetentionUntil).Scan(
		&ev.ID, &ev.ActorID, &hostRaw, &ev.Action, &ev.ResourceType, &ev.ResourceID,
		&ev.Outcome, &ev.CorrelationID, &detailsRaw, &ev.OccurredAt, &ev.RetentionUntil,
	)
	if err != nil {
		return AuditEvent{}, mapDBErr(err)
	}
	ev.HostContext = unmarshalObject(hostRaw)
	ev.Details = unmarshalObject(detailsRaw)
	return ev, nil
}

const stepColumns = `
	id::text, execution_id::text, node_id, node_type, attempt, status,
	COALESCE(lease_id::text, ''), fencing_token, COALESCE(idempotency_key, ''),
	policy_snapshot, target_snapshot, input_redacted, output_redacted, error_redacted,
	created_at, started_at, finished_at, updated_at
`

const jobColumns = `
	id::text, execution_id::text, execution_step_id::text, status, available_at,
	lease_expires_at, heartbeat_at, COALESCE(worker_id, ''), fencing_token, attempt,
	created_at, updated_at
`

const auditColumns = `
	id::text, COALESCE(actor_id::text, ''), host_context_redacted, action, resource_type,
	COALESCE(resource_id::text, ''), outcome, COALESCE(correlation_id, ''), details_redacted,
	occurred_at, retention_until
`

func scanExecution(row rowScanner) (Execution, error) {
	var exec Execution
	var inputRaw, policyRaw []byte
	var started, finished *time.Time
	if err := row.Scan(
		&exec.ID, &exec.WorkflowID, &exec.WorkflowSlug, &exec.WorkflowName,
		&exec.WorkflowVersionID, &exec.WorkflowDigest, &exec.TriggerID, &exec.Status,
		&exec.IdempotencyKey, &inputRaw, &policyRaw, &exec.CorrelationID, &exec.RequestedBy,
		&exec.CreatedAt, &started, &finished, &exec.UpdatedAt, &exec.RetentionUntil, &exec.fingerprint,
	); err != nil {
		return Execution{}, mapDBErr(err)
	}
	exec.Input = unmarshalObject(inputRaw)
	exec.PolicySnapshot = unmarshalObject(policyRaw)
	exec.StartedAt = started
	exec.FinishedAt = finished
	return exec, nil
}

func scanStep(row rowScanner) (ExecutionStep, error) {
	var step ExecutionStep
	var policyRaw, targetRaw, inputRaw, outputRaw, errorRaw []byte
	var started, finished *time.Time
	if err := row.Scan(
		&step.ID, &step.ExecutionID, &step.NodeID, &step.NodeType, &step.Attempt, &step.Status,
		&step.LeaseID, &step.FencingToken, &step.IdempotencyKey,
		&policyRaw, &targetRaw, &inputRaw, &outputRaw, &errorRaw,
		&step.CreatedAt, &started, &finished, &step.UpdatedAt,
	); err != nil {
		return ExecutionStep{}, mapDBErr(err)
	}
	step.PolicySnapshot = unmarshalObject(policyRaw)
	step.TargetSnapshot = unmarshalObject(targetRaw)
	step.Input = unmarshalObject(inputRaw)
	step.Output = unmarshalObject(outputRaw)
	step.Error = unmarshalObject(errorRaw)
	step.StartedAt = started
	step.FinishedAt = finished
	return step, nil
}

func scanJob(row rowScanner) (ExecutionJob, error) {
	var job ExecutionJob
	if err := row.Scan(
		&job.ID, &job.ExecutionID, &job.ExecutionStepID, &job.Status, &job.AvailableAt,
		&job.LeaseExpiresAt, &job.HeartbeatAt, &job.WorkerID, &job.FencingToken, &job.Attempt,
		&job.CreatedAt, &job.UpdatedAt,
	); err != nil {
		return ExecutionJob{}, mapDBErr(err)
	}
	return job, nil
}

func scanAudit(row rowScanner) (AuditEvent, error) {
	var ev AuditEvent
	var hostRaw, detailsRaw []byte
	if err := row.Scan(
		&ev.ID, &ev.ActorID, &hostRaw, &ev.Action, &ev.ResourceType, &ev.ResourceID,
		&ev.Outcome, &ev.CorrelationID, &detailsRaw, &ev.OccurredAt, &ev.RetentionUntil,
	); err != nil {
		return AuditEvent{}, mapDBErr(err)
	}
	ev.HostContext = unmarshalObject(hostRaw)
	ev.Details = unmarshalObject(detailsRaw)
	return ev, nil
}
