package wfstore

import (
	"context"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/jackc/pgx/v5"
)

func (p *Postgres) GetJob(ctx context.Context, scope isolation.Scope, jobID string) (ExecutionJob, error) {
	if scope.Zero() {
		return ExecutionJob{}, ErrNoScope
	}
	if !authz.ValidUUID(jobID) {
		return ExecutionJob{}, ErrNotFound
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return ExecutionJob{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	job, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM execution_jobs WHERE id = $1::uuid`, jobID))
	if err != nil {
		return ExecutionJob{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ExecutionJob{}, mapDBErr(err)
	}
	return job, nil
}

func (p *Postgres) ClaimJob(ctx context.Context, scope isolation.Scope, now time.Time, in ClaimInput) (DispatchResult, error) {
	if scope.Zero() {
		return DispatchResult{}, ErrNoScope
	}
	workerID, err := normalizeWorkerID(in.WorkerID)
	if err != nil {
		return DispatchResult{}, err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	lease := normalizeLease(in.Lease)
	ttl := normalizeBindingTTL(in.BindingTTL)

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	recovered, err := recoverExpiredTx(ctx, tx, scope, now)
	if err != nil {
		return DispatchResult{}, err
	}

	var jobID string
	err = tx.QueryRow(ctx, `
		SELECT j.id::text
		FROM execution_jobs j
		JOIN executions e ON e.workspace_id = j.workspace_id AND e.id = j.execution_id
		WHERE j.status = 'queued'
		  AND j.available_at <= $1
		  AND e.status IN ('queued', 'running')
		  AND NOT EXISTS (
			SELECT 1 FROM execution_jobs active
			WHERE active.workspace_id = j.workspace_id
			  AND active.execution_step_id = j.execution_step_id
			  AND active.status IN ('claimed', 'running')
		  )
		ORDER BY j.available_at, j.created_at
		FOR UPDATE OF j SKIP LOCKED
		LIMIT 1
	`, now).Scan(&jobID)
	if err != nil {
		if err == pgx.ErrNoRows || errorsIsNotFound(err) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return DispatchResult{}, mapDBErr(commitErr)
			}
			return DispatchResult{Recovered: recovered}, ErrEmptyClaim
		}
		return DispatchResult{}, mapDBErr(err)
	}

	leaseExp := now.Add(lease)
	job, err := scanJob(tx.QueryRow(ctx, `
		UPDATE execution_jobs
		SET status = 'claimed',
		    worker_id = $2,
		    fencing_token = fencing_token + 1,
		    lease_expires_at = $3,
		    heartbeat_at = NULL,
		    updated_at = $1
		WHERE id = $4::uuid
		RETURNING `+jobColumns, now, workerID, leaseExp, jobID))
	if err != nil {
		return DispatchResult{}, err
	}
	step, err := scanStep(tx.QueryRow(ctx, `
		UPDATE execution_steps
		SET status = 'running',
		    lease_id = $2::uuid,
		    fencing_token = $3,
		    started_at = COALESCE(started_at, $1),
		    finished_at = NULL,
		    updated_at = $1
		WHERE id = $4::uuid
		RETURNING `+stepColumns, now, job.ID, job.FencingToken, job.ExecutionStepID))
	if err != nil {
		return DispatchResult{}, err
	}
	if err := touchExecutionRunningTx(ctx, tx, job.ExecutionID, now); err != nil {
		return DispatchResult{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "job.claim",
		ResourceType: "execution",
		ResourceID:   job.ExecutionID,
		Outcome:      "claimed",
		Details:      map[string]any{"jobId": job.ID, "workerId": workerID, "fencingToken": job.FencingToken},
	}); err != nil {
		return DispatchResult{}, err
	}
	exec, err := getExecutionTx(ctx, tx, job.ExecutionID)
	if err != nil {
		return DispatchResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	return DispatchResult{
		Execution: exec,
		Step:      step,
		Job:       job,
		Binding:   buildBinding(scope.WorkspaceID(), exec, step, job, now.Add(ttl), leaseExp),
		Recovered: recovered,
	}, nil
}

func (p *Postgres) HeartbeatJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return p.mutateJob(ctx, scope, now, in, mutateOpts{
		action:  "job.heartbeat",
		outcome: "heartbeat",
		apply: func(job ExecutionJob) (string, map[string]any, error) {
			if err := matchFence(job, in); err != nil {
				return "", nil, err
			}
			if err := requireActiveLease(job, now); err != nil {
				return "", nil, err
			}
			return JobRunning, nil, nil
		},
		extendLease: true,
		running:     true,
	})
}

func (p *Postgres) ReleaseJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return p.mutateJob(ctx, scope, now, in, mutateOpts{
		action:  "job.release",
		outcome: "released",
		apply: func(job ExecutionJob) (string, map[string]any, error) {
			if err := matchFence(job, in); err != nil {
				return "", nil, err
			}
			if err := requireActiveLease(job, now); err != nil {
				return "", nil, err
			}
			if job.Status == JobRunning || job.HeartbeatAt != nil {
				return JobIndeterminate, nil, nil
			}
			return JobQueued, nil, nil
		},
		clearClaim: true,
	})
}

func (p *Postgres) CompleteJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return p.mutateJob(ctx, scope, now, in, mutateOpts{
		action:  "job.complete",
		outcome: "succeeded",
		apply: func(job ExecutionJob) (string, map[string]any, error) {
			if job.Status == JobSucceeded && matchFence(job, in) == nil {
				return JobSucceeded, nil, nil
			}
			if err := matchFence(job, in); err != nil {
				return "", nil, err
			}
			if err := requireActiveLease(job, now); err != nil {
				return "", nil, err
			}
			return JobSucceeded, redactObject(in.Output), nil
		},
		writeOutput: true,
	})
}

func (p *Postgres) FailJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return p.mutateJob(ctx, scope, now, in, mutateOpts{
		action:  "job.fail",
		outcome: "failed",
		apply: func(job ExecutionJob) (string, map[string]any, error) {
			if job.Status == JobFailed && matchFence(job, in) == nil {
				return JobFailed, nil, nil
			}
			if err := matchFence(job, in); err != nil {
				return "", nil, err
			}
			if err := requireActiveLease(job, now); err != nil {
				return "", nil, err
			}
			return JobFailed, redactObject(in.Error), nil
		},
		writeError: true,
	})
}

func (p *Postgres) CancelExecution(ctx context.Context, scope isolation.Scope, now time.Time, executionID string) (Execution, error) {
	if scope.Zero() {
		return Execution{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return Execution{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return Execution{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return Execution{}, err
	}
	if exec.Status == ExecutionCanceled {
		if err := tx.Commit(ctx); err != nil {
			return Execution{}, mapDBErr(err)
		}
		return exec, nil
	}
	if isTerminalExecution(exec.Status) && exec.Status != ExecutionPinned {
		return Execution{}, ErrAlreadyTerminal
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		SET status = 'canceled', updated_at = $1
		WHERE execution_id = $2::uuid AND status IN ('queued', 'claimed', 'running')
	`, now, executionID); err != nil {
		return Execution{}, mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'canceled', finished_at = COALESCE(finished_at, $1), updated_at = $1
		WHERE execution_id = $2::uuid AND status IN ('queued', 'running')
	`, now, executionID); err != nil {
		return Execution{}, mapDBErr(err)
	}
	if err := applyExecutionStatusTx(ctx, tx, executionID, ExecutionCanceled, now); err != nil {
		return Execution{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.cancel",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      "canceled",
	}); err != nil {
		return Execution{}, err
	}
	exec, err = getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return Execution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Execution{}, mapDBErr(err)
	}
	return exec, nil
}

func (p *Postgres) RetryStep(ctx context.Context, scope isolation.Scope, now time.Time, executionID, stepID string, hint ...map[string]any) (RetryResult, error) {
	if scope.Zero() {
		return RetryResult{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) || !authz.ValidUUID(stepID) {
		return RetryResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return RetryResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return RetryResult{}, err
	}
	src, err := scanStep(tx.QueryRow(ctx, `
		SELECT `+stepColumns+` FROM execution_steps WHERE execution_id = $1::uuid AND id = $2::uuid
	`, executionID, stepID))
	if err != nil {
		return RetryResult{}, err
	}
	if exec.Status == ExecutionIndeterminate && !allowsIndeterminateRetry(src.NodeType) {
		return RetryResult{}, ErrRetryNotAllowed
	}
	if len(hint) > 0 {
		applyRetryHint(&src, hint[0])
	}
	if err := canRetryStep(src); err != nil {
		return RetryResult{}, err
	}
	next := cloneStep(src)
	next.ID = newID()
	next.Attempt = src.Attempt + 1
	next.Status = ExecutionQueued
	next.LeaseID = ""
	next.FencingToken = 0
	next.Output = map[string]any{}
	next.Error = map[string]any{}
	next.CreatedAt = now
	next.UpdatedAt = now
	next.StartedAt = nil
	next.FinishedAt = nil
	inputRaw, err := marshalObject(next.Input)
	if err != nil {
		return RetryResult{}, ErrInvalid
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_steps (
			workspace_id, id, execution_id, node_id, node_type, attempt, status,
			input_redacted, created_at, updated_at
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9, $9)
	`, scope.WorkspaceID(), next.ID, executionID, next.NodeID, next.NodeType, next.Attempt, next.Status, inputRaw, now); err != nil {
		return RetryResult{}, mapDBErr(err)
	}
	job := ExecutionJob{
		ID:              newID(),
		ExecutionID:     executionID,
		ExecutionStepID: next.ID,
		Status:          JobQueued,
		AvailableAt:     now,
		Attempt:         next.Attempt,
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_jobs (
			workspace_id, id, execution_id, execution_step_id, status, available_at, attempt, created_at, updated_at
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $6, $6)
	`, scope.WorkspaceID(), job.ID, executionID, job.ExecutionStepID, job.Status, now, job.Attempt); err != nil {
		return RetryResult{}, mapDBErr(err)
	}
	if err := rollupExecutionTx(ctx, tx, executionID, now); err != nil {
		return RetryResult{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.retry",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      "queued",
		Details:      map[string]any{"stepId": next.ID, "attempt": next.Attempt, "nodeId": next.NodeID},
	}); err != nil {
		return RetryResult{}, err
	}
	exec, err = getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return RetryResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return RetryResult{}, mapDBErr(err)
	}
	return RetryResult{Execution: exec, Step: next, Job: job}, nil
}

func (p *Postgres) RecoverExpiredLeases(ctx context.Context, scope isolation.Scope, now time.Time) (int, error) {
	if scope.Zero() {
		return 0, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return 0, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	n, err := recoverExpiredTx(ctx, tx, scope, now)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, mapDBErr(err)
	}
	return n, nil
}

type mutateOpts struct {
	action      string
	outcome     string
	apply       func(ExecutionJob) (string, map[string]any, error)
	extendLease bool
	running     bool
	clearClaim  bool
	writeOutput bool
	writeError  bool
}

func (p *Postgres) mutateJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput, opts mutateOpts) (DispatchResult, error) {
	if scope.Zero() {
		return DispatchResult{}, ErrNoScope
	}
	if !authz.ValidUUID(in.JobID) {
		return DispatchResult{}, ErrNotFound
	}
	if _, err := normalizeWorkerID(in.WorkerID); err != nil {
		return DispatchResult{}, err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	job, err := scanJob(tx.QueryRow(ctx, `
		SELECT `+jobColumns+` FROM execution_jobs WHERE id = $1::uuid FOR UPDATE
	`, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	exec, err := getExecutionTx(ctx, tx, job.ExecutionID)
	if err != nil {
		return DispatchResult{}, err
	}
	if exec.Status == ExecutionCanceled && opts.action != "job.fail" && opts.action != "job.release" {
		return DispatchResult{}, ErrCanceled
	}
	nextStatus, payload, err := opts.apply(job)
	if err != nil {
		return DispatchResult{}, err
	}
	leaseExp := job.LeaseExpiresAt
	if opts.extendLease {
		exp := now.Add(normalizeLease(in.Lease))
		leaseExp = &exp
	}
	if nextStatus == JobQueued && opts.clearClaim {
		leaseExp = nil
	}
	var hb any
	if opts.running {
		hb = now
	} else if job.HeartbeatAt != nil && nextStatus != JobQueued {
		hb = *job.HeartbeatAt
	}
	worker := job.WorkerID
	if nextStatus == JobQueued && opts.clearClaim {
		worker = ""
	}
	job, err = scanJob(tx.QueryRow(ctx, `
		UPDATE execution_jobs
		SET status = $2,
		    worker_id = NULLIF($3, ''),
		    lease_expires_at = $4,
		    heartbeat_at = $5,
		    updated_at = $1
		WHERE id = $6::uuid
		RETURNING `+jobColumns, now, nextStatus, worker, leaseExp, hb, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	stepStatus := nextStatus
	if nextStatus == JobClaimed {
		stepStatus = ExecutionRunning
	}
	if nextStatus == JobQueued {
		stepStatus = ExecutionQueued
	}
	var outputRaw, errorRaw []byte
	if opts.writeOutput {
		outputRaw, err = marshalObject(payload)
		if err != nil {
			return DispatchResult{}, ErrInvalid
		}
	}
	if opts.writeError {
		errorRaw, err = marshalObject(payload)
		if err != nil {
			return DispatchResult{}, ErrInvalid
		}
	}
	leaseID := job.ID
	if nextStatus == JobQueued {
		leaseID = ""
	}
	q := `
		UPDATE execution_steps
		SET status = $2,
		    lease_id = NULLIF($3, '')::uuid,
		    fencing_token = $4,
		    started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, $1) ELSE started_at END,
		    finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled', 'indeterminate') THEN COALESCE(finished_at, $1)
		                       WHEN $2 IN ('queued', 'running') THEN NULL
		                       ELSE finished_at END,
		    updated_at = $1`
	args := []any{now, stepStatus, leaseID, job.FencingToken}
	if opts.writeOutput {
		q += `, output_redacted = $5::jsonb WHERE id = $6::uuid RETURNING ` + stepColumns
		args = append(args, outputRaw, job.ExecutionStepID)
	} else if opts.writeError {
		q += `, error_redacted = $5::jsonb WHERE id = $6::uuid RETURNING ` + stepColumns
		args = append(args, errorRaw, job.ExecutionStepID)
	} else {
		q += ` WHERE id = $5::uuid RETURNING ` + stepColumns
		args = append(args, job.ExecutionStepID)
	}
	step, err := scanStep(tx.QueryRow(ctx, q, args...))
	if err != nil {
		return DispatchResult{}, err
	}
	if err := rollupExecutionTx(ctx, tx, job.ExecutionID, now); err != nil {
		return DispatchResult{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       opts.action,
		ResourceType: "execution",
		ResourceID:   job.ExecutionID,
		Outcome:      opts.outcome,
		Details:      map[string]any{"jobId": job.ID, "fencingToken": job.FencingToken},
	}); err != nil {
		return DispatchResult{}, err
	}
	exec, err = getExecutionTx(ctx, tx, job.ExecutionID)
	if err != nil {
		return DispatchResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	exp := now.Add(DefaultJobBindingTTL)
	leaseAt := now
	if job.LeaseExpiresAt != nil {
		leaseAt = *job.LeaseExpiresAt
	}
	return DispatchResult{
		Execution: exec,
		Step:      step,
		Job:       job,
		Binding:   buildBinding(scope.WorkspaceID(), exec, step, job, exp, leaseAt),
	}, nil
}

func recoverExpiredTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time) (int, error) {
	rows, err := tx.Query(ctx, `
		UPDATE execution_jobs
		SET status = 'indeterminate', updated_at = $1
		WHERE status IN ('claimed', 'running')
		  AND lease_expires_at IS NOT NULL
		  AND lease_expires_at <= $1
		RETURNING execution_id::text, execution_step_id::text
	`, now)
	if err != nil {
		return 0, mapDBErr(err)
	}
	defer rows.Close()
	type pair struct{ exec, step string }
	var pairs []pair
	for rows.Next() {
		var p pair
		if err := rows.Scan(&p.exec, &p.step); err != nil {
			return 0, mapDBErr(err)
		}
		pairs = append(pairs, p)
	}
	if err := rows.Err(); err != nil {
		return 0, mapDBErr(err)
	}
	seen := map[string]struct{}{}
	for _, p := range pairs {
		if _, err := tx.Exec(ctx, `
			UPDATE execution_steps
			SET status = 'indeterminate', finished_at = COALESCE(finished_at, $1), updated_at = $1
			WHERE id = $2::uuid
		`, now, p.step); err != nil {
			return 0, mapDBErr(err)
		}
		if _, ok := seen[p.exec]; ok {
			continue
		}
		seen[p.exec] = struct{}{}
		if err := rollupExecutionTx(ctx, tx, p.exec, now); err != nil {
			return 0, err
		}
		if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
			Action:       "job.recover",
			ResourceType: "execution",
			ResourceID:   p.exec,
			Outcome:      "indeterminate",
			Details:      map[string]any{"reason": "lease-expired"},
		}); err != nil {
			return 0, err
		}
	}
	return len(pairs), nil
}

func rollupExecutionTx(ctx context.Context, tx pgx.Tx, executionID string, now time.Time) error {
	rows, err := tx.Query(ctx, `SELECT `+jobColumns+` FROM execution_jobs WHERE execution_id = $1::uuid`, executionID)
	if err != nil {
		return mapDBErr(err)
	}
	defer rows.Close()
	var jobs []ExecutionJob
	for rows.Next() {
		job, err := scanJob(rows)
		if err != nil {
			return err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return mapDBErr(err)
	}
	return applyExecutionStatusTx(ctx, tx, executionID, rollupExecutionStatus(jobs), now)
}

func applyExecutionStatusTx(ctx context.Context, tx pgx.Tx, executionID, status string, now time.Time) error {
	_, err := tx.Exec(ctx, `
		UPDATE executions
		SET status = $2,
		    started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, $1) ELSE started_at END,
		    finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled', 'indeterminate') THEN COALESCE(finished_at, $1)
		                       WHEN $2 IN ('queued', 'running') THEN NULL
		                       ELSE finished_at END,
		    updated_at = $1
		WHERE id = $3::uuid
	`, now, status, executionID)
	return mapDBErr(err)
}

func touchExecutionRunningTx(ctx context.Context, tx pgx.Tx, executionID string, now time.Time) error {
	return applyExecutionStatusTx(ctx, tx, executionID, ExecutionRunning, now)
}

func getExecutionTx(ctx context.Context, tx pgx.Tx, executionID string) (Execution, error) {
	return scanExecution(tx.QueryRow(ctx, `
		SELECT `+executionColumns+`
		FROM executions e
		JOIN workflows w ON w.workspace_id = e.workspace_id AND w.id = e.workflow_id
		WHERE e.id = $1::uuid
	`, executionID))
}

func errorsIsNotFound(err error) bool {
	return err != nil && (err == ErrNotFound || mapDBErr(err) == ErrNotFound)
}
