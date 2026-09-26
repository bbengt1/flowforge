package wfstore

import (
	"context"
	"errors"
	"sort"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
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

	// Lease recovery commits before the claim transaction. Holding an
	// expired-lease execution and then locking its workflow deadlocks with
	// delete, which locks the workflow first.
	recovered, err := p.RecoverExpiredLeases(ctx, scope, now)
	if err != nil {
		return DispatchResult{}, err
	}

	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)

	// The first read does not lock the job. Two claims can select the same
	// row; after the live workflow lock, the loser re-reads the next queued
	// job on that workflow instead of returning empty. A second workflow is
	// not locked in this transaction.
	var jobID, workflowID, executionID, lockedWorkflow string
	picked := false
	for attempt := 0; attempt < 8; attempt++ {
		args := []any{now}
		workflowClause := ""
		if lockedWorkflow != "" {
			workflowClause = " AND e.workflow_id = $2::uuid"
			args = append(args, lockedWorkflow)
		}
		err = tx.QueryRow(ctx, `
			SELECT j.id::text, e.workflow_id::text, e.id::text
			FROM execution_jobs j
			JOIN executions e ON e.workspace_id = j.workspace_id AND e.id = j.execution_id
			JOIN execution_steps s ON s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
			WHERE j.status = 'queued'
			  AND j.status <> 'blocked'
			  AND s.unresolved_incoming = 0
			  AND j.available_at <= $1
			  AND e.status IN ('queued', 'running', 'waiting')
			  AND NOT EXISTS (
				SELECT 1 FROM execution_jobs active
				WHERE active.workspace_id = j.workspace_id
				  AND active.execution_step_id = j.execution_step_id
				  AND active.status IN ('claimed', 'running')
			  )`+workflowClause+`
			ORDER BY j.available_at, j.created_at
			LIMIT 1
		`, args...).Scan(&jobID, &workflowID, &executionID)
		if err != nil {
			if err == pgx.ErrNoRows || errorsIsNotFound(err) {
				if commitErr := tx.Commit(ctx); commitErr != nil {
					return DispatchResult{}, mapDBErr(commitErr)
				}
				observability.NoteLeaseClaim(ctx, "empty", 0)
				return DispatchResult{Recovered: recovered}, ErrEmptyClaim
			}
			return DispatchResult{}, mapDBErr(err)
		}
		if lockedWorkflow == "" {
			if err := guardLiveWorkflowTx(ctx, tx, scope, now, workflowID, executionID); err != nil {
				if errors.Is(err, ErrWorkflowDeleted) {
					if commitErr := tx.Commit(ctx); commitErr != nil {
						return DispatchResult{}, mapDBErr(commitErr)
					}
					observability.NoteLeaseClaim(ctx, "empty", 0)
					return DispatchResult{Recovered: recovered}, ErrEmptyClaim
				}
				return DispatchResult{}, err
			}
			lockedWorkflow = workflowID
		}
		if err := lockExecutionTx(ctx, tx, executionID); err != nil {
			return DispatchResult{}, err
		}
		err = tx.QueryRow(ctx, `
			SELECT j.id::text
			FROM execution_jobs j
			JOIN executions e ON e.workspace_id = j.workspace_id AND e.id = j.execution_id
			JOIN execution_steps s ON s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
			WHERE j.id = $1::uuid
			  AND j.status = 'queued'
			  AND j.status <> 'blocked'
			  AND s.unresolved_incoming = 0
			  AND j.available_at <= $2
			  AND e.status IN ('queued', 'running', 'waiting')
			  AND e.workflow_id = $3::uuid
			  AND NOT EXISTS (
				SELECT 1 FROM execution_jobs active
				WHERE active.workspace_id = j.workspace_id
				  AND active.execution_step_id = j.execution_step_id
				  AND active.status IN ('claimed', 'running')
			  )
			FOR UPDATE OF j
		`, jobID, now, lockedWorkflow).Scan(&jobID)
		if err == nil {
			picked = true
			break
		}
		if err == pgx.ErrNoRows || errorsIsNotFound(err) {
			continue
		}
		return DispatchResult{}, mapDBErr(err)
	}
	if !picked {
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return DispatchResult{}, mapDBErr(commitErr)
		}
		observability.NoteLeaseClaim(ctx, "empty", 0)
		return DispatchResult{Recovered: recovered}, ErrEmptyClaim
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
	lag := now.Sub(job.AvailableAt)
	observability.NoteLeaseClaim(ctx, "claimed", lag)
	observability.NoteQueueLeft(ctx, 1)
	return DispatchResult{
		Execution: exec,
		Step:      step,
		Job:       job,
		Binding:   buildBinding(scope, exec, step, job, now.Add(ttl), leaseExp),
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
		writeOutput:      true,
		releaseOnSuccess: true,
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
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return Execution{}, err
	}
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return Execution{}, err
	}
	if exec.Status == ExecutionCanceled {
		if _, err := closePendingApprovalsTx(ctx, tx, executionID, ReasonRunCanceled, now); err != nil {
			return Execution{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return Execution{}, mapDBErr(err)
		}
		return exec, nil
	}
	if isTerminalExecution(exec.Status) && exec.Status != ExecutionPinned {
		return Execution{}, ErrAlreadyTerminal
	}
	var queued int
	if err := tx.QueryRow(ctx, `
		SELECT count(*) FROM execution_jobs
		WHERE execution_id = $1::uuid AND status = 'queued'
	`, executionID).Scan(&queued); err != nil {
		return Execution{}, mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_jobs
		SET status = 'canceled', updated_at = $1
		WHERE execution_id = $2::uuid AND status IN ('blocked', 'queued', 'claimed', 'running', 'waiting')
	`, now, executionID); err != nil {
		return Execution{}, mapDBErr(err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE execution_steps
		SET status = 'canceled', finished_at = COALESCE(finished_at, $1), updated_at = $1
		WHERE execution_id = $2::uuid AND status IN ('pending', 'queued', 'running', 'waiting')
	`, now, executionID); err != nil {
		return Execution{}, mapDBErr(err)
	}
	if err := applyExecutionStatusTx(ctx, tx, executionID, ExecutionCanceled, now); err != nil {
		return Execution{}, err
	}
	closed, err := closePendingApprovalsTx(ctx, tx, executionID, ReasonRunCanceled, now)
	if err != nil {
		return Execution{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "execution.cancel",
		ResourceType: "execution",
		ResourceID:   executionID,
		Outcome:      "canceled",
		Details:      map[string]any{"approvalsClosed": closed},
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
	observability.NoteQueueLeft(ctx, queued)
	observability.NoteExecutionOutcome(ctx, "canceled")
	return exec, nil
}

func (p *Postgres) EmergencyStop(ctx context.Context, scope isolation.Scope, now time.Time, in EmergencyStopInput) (EmergencyStopResult, error) {
	if scope.Zero() {
		return EmergencyStopResult{}, ErrNoScope
	}
	if !authz.ValidUUID(in.ExecutionID) {
		return EmergencyStopResult{}, ErrNotFound
	}
	if in.StepID != "" && !authz.ValidUUID(in.StepID) {
		return EmergencyStopResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return EmergencyStopResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	if err := lockExecutionsSorted(ctx, tx, []string{in.ExecutionID}); err != nil {
		return EmergencyStopResult{}, err
	}
	exec, err := getExecutionTx(ctx, tx, in.ExecutionID)
	if err != nil {
		return EmergencyStopResult{}, err
	}
	stepRows, err := tx.Query(ctx, `SELECT `+stepColumns+` FROM execution_steps WHERE execution_id = $1::uuid`, in.ExecutionID)
	if err != nil {
		return EmergencyStopResult{}, mapDBErr(err)
	}
	var steps []ExecutionStep
	for stepRows.Next() {
		step, scanErr := scanStep(stepRows)
		if scanErr != nil {
			stepRows.Close()
			return EmergencyStopResult{}, scanErr
		}
		steps = append(steps, step)
	}
	stepRows.Close()
	if err := stepRows.Err(); err != nil {
		return EmergencyStopResult{}, mapDBErr(err)
	}
	jobRows, err := tx.Query(ctx, `SELECT `+jobColumns+` FROM execution_jobs WHERE execution_id = $1::uuid`, in.ExecutionID)
	if err != nil {
		return EmergencyStopResult{}, mapDBErr(err)
	}
	var jobs []ExecutionJob
	for jobRows.Next() {
		job, scanErr := scanJob(jobRows)
		if scanErr != nil {
			jobRows.Close()
			return EmergencyStopResult{}, scanErr
		}
		jobs = append(jobs, job)
	}
	jobRows.Close()
	if err := jobRows.Err(); err != nil {
		return EmergencyStopResult{}, mapDBErr(err)
	}

	stopped := 0
	uncertain := false
	matched := 0
	for _, step := range steps {
		if in.StepID != "" && step.ID != in.StepID {
			continue
		}
		if !scripts.IsScriptNode(step.NodeType) {
			if in.StepID != "" {
				return EmergencyStopResult{}, ErrEmergencyStopNotApplicable
			}
			continue
		}
		matched++
		var chosen *ExecutionJob
		for i := range jobs {
			if jobs[i].ExecutionStepID != step.ID {
				continue
			}
			if jobIsOpen(jobs[i].Status) {
				chosen = &jobs[i]
				break
			}
			if jobs[i].Status == JobIndeterminate && chosen == nil {
				chosen = &jobs[i]
			}
		}
		if chosen == nil {
			continue
		}
		if !jobIsOpen(chosen.Status) {
			if chosen.Status == JobIndeterminate {
				uncertain = true
			}
			continue
		}
		next := emergencyStopJobStatus(*chosen, in.Uncertain)
		if _, err := tx.Exec(ctx, `
			UPDATE execution_jobs SET status = $2, updated_at = $1 WHERE id = $3::uuid
		`, now, next, chosen.ID); err != nil {
			return EmergencyStopResult{}, mapDBErr(err)
		}
		stepStatus := emergencyStopStepStatus(next)
		if _, err := tx.Exec(ctx, `
			UPDATE execution_steps
			   SET status = $2, finished_at = COALESCE(finished_at, $1), updated_at = $1
			 WHERE id = $3::uuid
		`, now, stepStatus, step.ID); err != nil {
			return EmergencyStopResult{}, mapDBErr(err)
		}
		if next == JobIndeterminate {
			uncertain = true
		}
		stopped++
	}
	if in.StepID != "" && matched == 0 {
		return EmergencyStopResult{}, ErrNotFound
	}
	if matched == 0 {
		return EmergencyStopResult{}, ErrEmergencyStopNotApplicable
	}
	if stopped == 0 {
		if exec.Status == ExecutionIndeterminate {
			if err := tx.Commit(ctx); err != nil {
				return EmergencyStopResult{}, mapDBErr(err)
			}
			return EmergencyStopResult{Execution: exec, Outcome: ExecutionIndeterminate, Uncertain: true}, nil
		}
		if isTerminalExecution(exec.Status) && exec.Status != ExecutionPinned {
			return EmergencyStopResult{}, ErrAlreadyTerminal
		}
		return EmergencyStopResult{}, ErrEmergencyStopNotApplicable
	}
	if err := rollupExecutionTx(ctx, tx, in.ExecutionID, now); err != nil {
		return EmergencyStopResult{}, err
	}
	exec, err = getExecutionTx(ctx, tx, in.ExecutionID)
	if err != nil {
		return EmergencyStopResult{}, err
	}
	outcome := exec.Status
	if uncertain {
		outcome = ExecutionIndeterminate
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       scripts.AuditEmergencyStop,
		ResourceType: "execution",
		ResourceID:   in.ExecutionID,
		Outcome:      outcome,
		Details:      scripts.EmergencyStopAudit(in.ExecutionID, in.StepID, "", outcome, scope.ActorID(), uncertain || in.Uncertain),
	}); err != nil {
		return EmergencyStopResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return EmergencyStopResult{}, mapDBErr(err)
	}
	return EmergencyStopResult{
		Execution: exec,
		Outcome:   outcome,
		Uncertain: uncertain || in.Uncertain,
		Stopped:   stopped,
	}, nil
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
	var workflowID string
	if err := tx.QueryRow(ctx, `SELECT workflow_id::text FROM executions WHERE id = $1::uuid`, executionID).Scan(&workflowID); err != nil {
		return RetryResult{}, mapDBErr(err)
	}
	if err := guardLiveWorkflowTx(ctx, tx, scope, now, workflowID, executionID); err != nil {
		if errors.Is(err, ErrWorkflowDeleted) {
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return RetryResult{}, mapDBErr(commitErr)
			}
			return RetryResult{}, &NotRetryableError{Reason: ReasonWorkflowDeleted}
		}
		return RetryResult{}, err
	}
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return RetryResult{}, err
	}
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return RetryResult{}, err
	}
	src, err := scanStep(tx.QueryRow(ctx, `
		SELECT `+stepColumns+` FROM execution_steps WHERE execution_id = $1::uuid AND id = $2::uuid FOR UPDATE
	`, executionID, stepID))
	if err != nil {
		return RetryResult{}, err
	}
	steps, err := loadStepsTx(ctx, tx, executionID)
	if err != nil {
		return RetryResult{}, err
	}
	edges, err := loadEdgesTx(ctx, tx, executionID)
	if err != nil {
		return RetryResult{}, err
	}
	if err := retryStatusError(exec, src, steps); err != nil {
		return RetryResult{}, err
	}
	if len(hint) > 0 {
		applyRetryHint(&src, hint[0])
	}
	if err := canRetryStep(src); err != nil {
		return RetryResult{}, err
	}
	unresolved, err := incomingRetryError(src.NodeID, edges)
	if err != nil {
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
	next.UnresolvedIncoming = unresolved
	inputRaw, err := marshalObject(next.Input)
	if err != nil {
		return RetryResult{}, ErrInvalid
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_steps (
			workspace_id, id, execution_id, node_id, node_type, attempt, status,
			input_redacted, unresolved_incoming, created_at, updated_at
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::jsonb, $9, $10, $10)
	`, scope.WorkspaceID(), next.ID, executionID, next.NodeID, next.NodeType, next.Attempt, next.Status, inputRaw, unresolved, now); err != nil {
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
	stamped := []ExecutionJob{job}
	stampJobs(ctx, stamped)
	job = stamped[0]
	if _, err := tx.Exec(ctx, `
		INSERT INTO execution_jobs (
			workspace_id, id, execution_id, execution_step_id, status, available_at, attempt,
			created_at, updated_at, traceparent, tracestate
		) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $6, $6, NULLIF($8, ''), NULLIF($9, ''))
	`, scope.WorkspaceID(), job.ID, executionID, job.ExecutionStepID, job.Status, now, job.Attempt, job.TraceParent, job.TraceState); err != nil {
		return RetryResult{}, mapDBErr(err)
	}
	observability.NoteJobEnqueued(ctx, 1)
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

func (p *Postgres) WaitJob(ctx context.Context, scope isolation.Scope, now time.Time, in WaitJobInput) (DispatchResult, error) {
	if scope.Zero() {
		return DispatchResult{}, ErrNoScope
	}
	if !authz.ValidUUID(in.JobID) {
		return DispatchResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	executionID, _, _, err := peekJobTx(ctx, tx, in.JobID)
	if err != nil {
		return DispatchResult{}, err
	}
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return DispatchResult{}, err
	}
	job, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM execution_jobs WHERE id = $1::uuid FOR UPDATE`, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	if job.Status == JobWaiting {
		step, err := scanStep(tx.QueryRow(ctx, `SELECT `+stepColumns+` FROM execution_steps WHERE id = $1::uuid`, job.ExecutionStepID))
		if err != nil {
			return DispatchResult{}, err
		}
		if err := ensureParkedApprovalTx(ctx, tx, scope, in, job.AvailableAt, job.ExecutionID, step.NodeType); err != nil {
			return DispatchResult{}, err
		}
		return p.dispatchSnapshotTx(ctx, tx, scope, now, job)
	}
	if job.Status != JobClaimed && job.Status != JobRunning && job.Status != JobQueued {
		return DispatchResult{}, ErrNotClaimable
	}
	avail := job.AvailableAt
	if !in.AvailableAt.IsZero() {
		avail = in.AvailableAt.UTC()
	}
	job, err = scanJob(tx.QueryRow(ctx, `
		UPDATE execution_jobs
		SET status = 'waiting', worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
		    available_at = $2, updated_at = $1
		WHERE id = $3::uuid
		RETURNING `+jobColumns, now, avail, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	step, err := scanStep(tx.QueryRow(ctx, `
		UPDATE execution_steps
		SET status = 'waiting', lease_id = NULL, finished_at = NULL, updated_at = $1
		WHERE id = $2::uuid
		RETURNING `+stepColumns, now, job.ExecutionStepID))
	if err != nil {
		return DispatchResult{}, err
	}
	if err := rollupExecutionTx(ctx, tx, job.ExecutionID, now); err != nil {
		return DispatchResult{}, err
	}
	if err := ensureParkedApprovalTx(ctx, tx, scope, in, avail, job.ExecutionID, step.NodeType); err != nil {
		return DispatchResult{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "job.wait",
		ResourceType: "execution",
		ResourceID:   job.ExecutionID,
		Outcome:      "waiting",
		Details:      map[string]any{"jobId": job.ID, "nodeId": step.NodeID},
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
		Binding:   buildBinding(scope, exec, step, job, now.Add(DefaultJobBindingTTL), now),
	}, nil
}

// ensureParkedApprovalTx inserts the approval in the park transaction.
// expires_at is the wait deadline already stored on the job, not a new
// computation from the caller's clock.
func ensureParkedApprovalTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, in WaitJobInput, deadline time.Time, executionID, nodeType string) error {
	if in.Approval == nil || nodeType != "flow.approval" {
		return nil
	}
	if deadline.IsZero() {
		return ErrInvalid
	}
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	seed := *in.Approval
	if seed.WorkflowID == "" {
		seed.WorkflowID = exec.WorkflowID
	}
	if seed.WorkflowVersionID == "" {
		seed.WorkflowVersionID = exec.WorkflowVersionID
	}
	if seed.WorkflowDigest == "" {
		seed.WorkflowDigest = exec.WorkflowDigest
	}
	if seed.ExecutionID == "" {
		seed.ExecutionID = exec.ID
	}
	if seed.RequestedBy == "" {
		seed.RequestedBy = exec.RequestedBy
	}
	if strings.TrimSpace(seed.NodeID) == "" {
		return ErrInvalid
	}
	err = parkedapproval.Insert(ctx, tx, parkedapproval.Pending{
		WorkspaceID:       scope.WorkspaceID(),
		ActorID:           scope.ActorID(),
		WorkflowID:        seed.WorkflowID,
		WorkflowVersionID: seed.WorkflowVersionID,
		WorkflowDigest:    seed.WorkflowDigest,
		ExecutionID:       seed.ExecutionID,
		RequestedBy:       seed.RequestedBy,
		NodeID:            seed.NodeID,
		NodeName:          seed.NodeName,
		Operation:         seed.Operation,
		ApproverRole:      seed.ApproverRole,
		TargetKind:        seed.TargetKind,
		TargetID:          seed.TargetID,
		TargetVersionID:   seed.TargetVersionID,
		TargetDigest:      seed.TargetDigest,
		PolicyResourceID:  seed.PolicyResourceID,
		PolicyVersionID:   seed.PolicyVersionID,
		PolicyDigest:      seed.PolicyDigest,
		PolicyRevision:    seed.PolicyRevision,
		ExpiresAt:         deadline,
	})
	if errors.Is(err, parkedapproval.ErrInvalid) {
		return ErrInvalid
	}
	return mapDBErr(err)
}

func expireParkedGateTx(ctx context.Context, tx pgx.Tx, executionID, nodeID string, now time.Time) error {
	return mapDBErr(parkedapproval.Expire(ctx, tx, executionID, nodeID, now))
}

func (p *Postgres) ResumeWait(ctx context.Context, scope isolation.Scope, now time.Time, in ResumeWaitInput) (DispatchResult, error) {
	if scope.Zero() {
		return DispatchResult{}, ErrNoScope
	}
	if !authz.ValidUUID(in.JobID) {
		return DispatchResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	port := strings.TrimSpace(in.Port)
	if port == "" {
		port = "expired"
	}
	tx, err := postgres.BeginScoped(ctx, p.db, scope.WorkspaceID())
	if err != nil {
		return DispatchResult{}, mapDBErr(err)
	}
	defer tx.Rollback(ctx)
	executionID, workflowID, peeked, err := peekJobTx(ctx, tx, in.JobID)
	if err != nil {
		return DispatchResult{}, err
	}
	if peeked != JobSucceeded {
		if err := guardLiveWorkflowTx(ctx, tx, scope, now, workflowID, executionID); err != nil {
			if errors.Is(err, ErrWorkflowDeleted) {
				if commitErr := tx.Commit(ctx); commitErr != nil {
					return DispatchResult{}, mapDBErr(commitErr)
				}
				return DispatchResult{}, ErrWorkflowDeleted
			}
			return DispatchResult{}, err
		}
	}
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return DispatchResult{}, err
	}
	job, err := scanJob(tx.QueryRow(ctx, `SELECT `+jobColumns+` FROM execution_jobs WHERE id = $1::uuid FOR UPDATE`, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	if job.Status == JobSucceeded {
		return p.dispatchSnapshotTx(ctx, tx, scope, now, job)
	}
	if job.Status != JobWaiting || peeked == JobSucceeded {
		return DispatchResult{}, ErrNotClaimable
	}
	payload, err := marshalObject(redactObject(waitOutput(port, in.Output)))
	if err != nil {
		return DispatchResult{}, ErrInvalid
	}
	job, err = scanJob(tx.QueryRow(ctx, `
		UPDATE execution_jobs SET status = 'succeeded', updated_at = $1 WHERE id = $2::uuid
		RETURNING `+jobColumns, now, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	step, err := scanStep(tx.QueryRow(ctx, `
		UPDATE execution_steps
		SET status = 'succeeded', output_redacted = $2::jsonb, finished_at = COALESCE(finished_at, $1), updated_at = $1
		WHERE id = $3::uuid
		RETURNING `+stepColumns, now, payload, job.ExecutionStepID))
	if err != nil {
		return DispatchResult{}, err
	}
	if err := resolveOutgoingTx(ctx, tx, job.ExecutionID, step.NodeID, emittedPorts(step.NodeType, step.Output), now); err != nil {
		return DispatchResult{}, err
	}
	if port == "expired" && step.NodeType == "flow.approval" {
		if err := expireParkedGateTx(ctx, tx, job.ExecutionID, step.NodeID, now); err != nil {
			return DispatchResult{}, err
		}
	}
	if err := rollupExecutionTx(ctx, tx, job.ExecutionID, now); err != nil {
		return DispatchResult{}, err
	}
	if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
		Action:       "job.resume",
		ResourceType: "execution",
		ResourceID:   job.ExecutionID,
		Outcome:      port,
		Details:      map[string]any{"jobId": job.ID, "nodeId": step.NodeID},
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
		Binding:   buildBinding(scope, exec, step, job, now.Add(DefaultJobBindingTTL), now),
	}, nil
}

func (p *Postgres) dispatchSnapshotTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, job ExecutionJob) (DispatchResult, error) {
	step, err := scanStep(tx.QueryRow(ctx, `SELECT `+stepColumns+` FROM execution_steps WHERE id = $1::uuid`, job.ExecutionStepID))
	if err != nil {
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
		Binding:   buildBinding(scope, exec, step, job, now.Add(DefaultJobBindingTTL), now),
	}, nil
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
	action           string
	outcome          string
	apply            func(ExecutionJob) (string, map[string]any, error)
	extendLease      bool
	running          bool
	clearClaim       bool
	writeOutput      bool
	writeError       bool
	releaseOnSuccess bool
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
	executionID, workflowID, _, err := peekJobTx(ctx, tx, in.JobID)
	if err != nil {
		return DispatchResult{}, err
	}
	if opts.clearClaim {
		if err := guardLiveWorkflowTx(ctx, tx, scope, now, workflowID, executionID); err != nil {
			if errors.Is(err, ErrWorkflowDeleted) {
				if commitErr := tx.Commit(ctx); commitErr != nil {
					return DispatchResult{}, mapDBErr(commitErr)
				}
				return DispatchResult{}, ErrWorkflowDeleted
			}
			return DispatchResult{}, err
		}
	}
	if err := lockExecutionTx(ctx, tx, executionID); err != nil {
		return DispatchResult{}, err
	}
	job, err := scanJob(tx.QueryRow(ctx, `
		SELECT `+jobColumns+` FROM execution_jobs WHERE id = $1::uuid FOR UPDATE
	`, in.JobID))
	if err != nil {
		return DispatchResult{}, err
	}
	prevStatus := job.Status
	exec, err := getExecutionTx(ctx, tx, job.ExecutionID)
	if err != nil {
		return DispatchResult{}, err
	}
	if exec.Status == ExecutionCanceled && opts.action != "job.fail" && opts.action != "job.release" {
		return DispatchResult{}, ErrCanceled
	}
	if in.ApprovalTransientRetry {
		nodeType, input, expires, ready, err := pendingApprovalExpiresTx(ctx, tx, job.ExecutionStepID)
		if err != nil {
			return DispatchResult{}, err
		}
		if nodeType == "flow.approval" && ApprovalPastLimit(ready, expires, input, now) {
			orig := opts.apply
			opts.apply = func(job ExecutionJob) (string, map[string]any, error) {
				status, payload, err := orig(job)
				if err != nil || status != JobQueued {
					return status, payload, err
				}
				return JobFailed, requirementUnresolvableStepError(), nil
			}
			opts.writeError = true
			opts.action = "job.fail"
			opts.outcome = "failed"
		}
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
	q := `
		UPDATE execution_jobs
		SET status = $2,
		    worker_id = NULLIF($3, ''),
		    lease_expires_at = $4,
		    heartbeat_at = $5,
		    updated_at = $1`
	args := []any{now, nextStatus, worker, leaseExp, hb}
	if nextStatus == JobQueued && in.ApprovalTransientRetry {
		delay := approvalRetryWait(approvalJitter())
		q += `, available_at = $6 WHERE id = $7::uuid RETURNING ` + jobColumns
		args = append(args, now.Add(delay), in.JobID)
	} else {
		q += ` WHERE id = $6::uuid RETURNING ` + jobColumns
		args = append(args, in.JobID)
	}
	job, err = scanJob(tx.QueryRow(ctx, q, args...))
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
	q = `
		UPDATE execution_steps
		SET status = $2,
		    lease_id = NULLIF($3, '')::uuid,
		    fencing_token = $4,
		    started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, $1) ELSE started_at END,
		    finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled', 'indeterminate') THEN COALESCE(finished_at, $1)
		                       WHEN $2 IN ('queued', 'running', 'waiting') THEN NULL
		                       ELSE finished_at END,
		    updated_at = $1`
	args = []any{now, stepStatus, leaseID, job.FencingToken}
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
	if opts.writeError {
		if code, _ := payload["code"].(string); code == ReasonRequirementUnresolvable {
			if err := parkedapproval.CancelUnresolvable(ctx, tx, job.ExecutionID, step.NodeID, now); err != nil {
				return DispatchResult{}, mapDBErr(err)
			}
		}
	}
	if opts.releaseOnSuccess && nextStatus == JobSucceeded && prevStatus != JobSucceeded {
		if err := resolveOutgoingTx(ctx, tx, job.ExecutionID, step.NodeID, emittedPorts(step.NodeType, step.Output), now); err != nil {
			return DispatchResult{}, err
		}
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
	observability.NoteExecutionOutcome(ctx, opts.outcome)
	exp := now.Add(DefaultJobBindingTTL)
	leaseAt := now
	if job.LeaseExpiresAt != nil {
		leaseAt = *job.LeaseExpiresAt
	}
	return DispatchResult{
		Execution: exec,
		Step:      step,
		Job:       job,
		Binding:   buildBinding(scope, exec, step, job, exp, leaseAt),
	}, nil
}

func recoverExpiredTx(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time) (int, error) {
	// Lock order is workflow, then executions sorted by id, then steps and
	// jobs. Lease rows are included in that workflow set so recovery never
	// locks an execution whose workflow is still unlocked.
	due, err := loadDueWaits(ctx, tx, now)
	if err != nil {
		return 0, err
	}
	leaseIDs, leaseWorkflows, err := expiredLeaseExecutions(ctx, tx, now)
	if err != nil {
		return 0, err
	}
	workflowIDs := append([]string{}, leaseWorkflows...)
	for _, row := range due {
		workflowIDs = append(workflowIDs, row.workflowID)
	}
	deleted, err := lockWorkflowsSorted(ctx, tx, workflowIDs)
	if err != nil {
		return 0, err
	}
	execIDs := append([]string{}, leaseIDs...)
	for _, row := range due {
		execIDs = append(execIDs, row.exec)
	}
	if err := lockExecutionsSorted(ctx, tx, execIDs); err != nil {
		return 0, err
	}

	n := 0
	if len(leaseIDs) == 0 {
		stopped, resumed, err := resumeOrStopDueWaits(ctx, tx, scope, now, due, deleted)
		if err != nil {
			return 0, err
		}
		return stopped + resumed, nil
	}
	// A claimed approval whose rebuild failed has no pending row. Inside
	// the gate-ready time plus the parked-approval wait duration, put it
	// back on the queue after the flat retry delay. The gate-ready time is
	// the latest finished_at among satisfied upstream steps, or the run's
	// started_at for a root gate. Do not burn the attempt and do not park
	// it as waiting, or the deadline takes expired. A pending approval uses
	// that row's expires_at as the limit instead. Past the limit, fail
	// the job and step with requirement_unresolvable, cancel a pending
	// approval for that execution and node in this transaction, and roll the
	// run up. A claim that still has a pending approval and is inside the
	// limit parks as waiting. A gate that is already waiting is not in this set.
	settled, err := requeueOrFailTransientApprovals(ctx, tx, scope, now, leaseIDs)
	if err != nil {
		return 0, err
	}
	n += settled

	rows, err := tx.Query(ctx, `
		UPDATE execution_jobs
		SET status = 'indeterminate', updated_at = $1
		WHERE execution_id = ANY($2::uuid[])
		  AND status IN ('claimed', 'running')
		  AND lease_expires_at IS NOT NULL
		  AND lease_expires_at <= $1
		RETURNING execution_id::text, execution_step_id::text
	`, now, leaseIDs)
	if err != nil {
		return 0, mapDBErr(err)
	}
	pairs, err := collectRecoverPairs(rows)
	if err != nil {
		return 0, err
	}
	for _, p := range pairs {
		if _, err := tx.Exec(ctx, `
			UPDATE execution_steps
			SET status = 'indeterminate', finished_at = COALESCE(finished_at, $1), updated_at = $1
			WHERE id = $2::uuid
		`, now, p.step); err != nil {
			return 0, mapDBErr(err)
		}
		n++
	}
	if err := finishRecoverPairs(ctx, tx, scope, now, pairs, "indeterminate"); err != nil {
		return 0, err
	}
	observability.NoteLeaseExpired(ctx, len(pairs))
	for range pairs {
		observability.NoteExecutionOutcome(ctx, "indeterminate")
	}

	stopped, resumed, err := resumeOrStopDueWaits(ctx, tx, scope, now, due, deleted)
	if err != nil {
		return 0, err
	}
	return n + stopped + resumed, nil
}

type transientApprovalRow struct {
	jobID   string
	exec    string
	step    string
	nodeID  string
	ready   time.Time
	expires time.Time
	input   map[string]any
	pending bool
}

// gateReadyAtSQL is the gate-ready time for the step aliased as s.
// execution_jobs has no finished_at. The finish time of a satisfied
// upstream job is that step's finished_at, and the latest of those is
// when the gate became ready. A root gate uses the execution started_at.
// The expression takes no row lock.
const gateReadyAtSQL = `
COALESCE(
  (SELECT max(up.finished_at)
     FROM execution_edges e
     JOIN execution_steps up
       ON up.workspace_id = e.workspace_id
      AND up.execution_id = e.execution_id
      AND up.node_id = e.from_node
    WHERE e.workspace_id = s.workspace_id
      AND e.execution_id = s.execution_id
      AND e.to_node = s.node_id
      AND e.satisfied
      AND up.finished_at IS NOT NULL),
  (SELECT ex.started_at
     FROM executions ex
    WHERE ex.workspace_id = s.workspace_id
      AND ex.id = s.execution_id)
)`

// pendingApprovalExpiresTx reads a pending approval's expires_at and the
// gate-ready time for the step. Neither select locks the approval row.
// Callers already hold the execution lock and the job row.
func pendingApprovalExpiresTx(ctx context.Context, tx pgx.Tx, stepID string) (string, map[string]any, time.Time, time.Time, error) {
	var nodeType string
	var raw []byte
	var expires, ready *time.Time
	err := tx.QueryRow(ctx, `
		SELECT s.node_type, s.input_redacted,
		       (
			SELECT a.expires_at
			  FROM approvals a
			 WHERE a.workspace_id = s.workspace_id
			   AND a.execution_id = s.execution_id
			   AND a.node_id = s.node_id
			   AND a.status = 'pending'
			 ORDER BY a.expires_at
			 LIMIT 1
		       ),
		       `+gateReadyAtSQL+`
		  FROM execution_steps s
		 WHERE s.id = $1::uuid
	`, stepID).Scan(&nodeType, &raw, &expires, &ready)
	if err != nil {
		return "", nil, time.Time{}, time.Time{}, mapDBErr(err)
	}
	input := unmarshalObject(raw)
	var exp, at time.Time
	if expires != nil {
		exp = expires.UTC()
	}
	if ready != nil {
		at = ready.UTC()
	}
	return nodeType, input, exp, at, nil
}

// requeueOrFailTransientApprovals locks each expired approval claim, then
// delays it, parks it, or fails it. Jobs are locked before their steps.
// Outgoing edges are not resolved. A past-limit failure also cancels a
// pending approval for that execution and node before the roll-up.
func requeueOrFailTransientApprovals(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, leaseIDs []string) (int, error) {
	rows, err := tx.Query(ctx, `
		SELECT j.id::text, j.execution_id::text, j.execution_step_id::text, s.node_id, `+gateReadyAtSQL+`, s.input_redacted,
		       (
			SELECT a.expires_at FROM approvals a
			WHERE a.workspace_id = j.workspace_id
			  AND a.execution_id = j.execution_id
			  AND a.node_id = s.node_id
			  AND a.status = 'pending'
			ORDER BY a.expires_at
			LIMIT 1
		       )
		FROM execution_jobs j
		JOIN execution_steps s
		  ON s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
		WHERE j.execution_id = ANY($2::uuid[])
		  AND j.status IN ('claimed', 'running')
		  AND j.lease_expires_at IS NOT NULL
		  AND j.lease_expires_at <= $1
		  AND s.node_type = 'flow.approval'
		FOR UPDATE OF j
	`, now, leaseIDs)
	if err != nil {
		return 0, mapDBErr(err)
	}
	defer rows.Close()
	var items []transientApprovalRow
	for rows.Next() {
		var row transientApprovalRow
		var raw []byte
		var ready, expires *time.Time
		if err := rows.Scan(&row.jobID, &row.exec, &row.step, &row.nodeID, &ready, &raw, &expires); err != nil {
			return 0, mapDBErr(err)
		}
		row.input = unmarshalObject(raw)
		if ready != nil {
			row.ready = ready.UTC()
		}
		if expires != nil {
			row.pending = true
			row.expires = expires.UTC()
		}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		return 0, mapDBErr(err)
	}
	errRaw, err := marshalObject(requirementUnresolvableStepError())
	if err != nil {
		return 0, ErrInvalid
	}
	delay := approvalRetryWait(approvalJitter())
	available := now.Add(delay)
	var requeuePairs, failPairs, parkPairs []recoverPair
	for _, row := range items {
		if ApprovalPastLimit(row.ready, row.expires, row.input, now) {
			tag, err := tx.Exec(ctx, `
				UPDATE execution_jobs
				SET status = 'failed', worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = $1
				WHERE id = $2::uuid AND status IN ('claimed', 'running')
			`, now, row.jobID)
			if err != nil {
				return 0, mapDBErr(err)
			}
			if tag.RowsAffected() == 0 {
				continue
			}
			if _, err := tx.Exec(ctx, `
				UPDATE execution_steps
				SET status = 'failed', error_redacted = $2::jsonb, lease_id = NULL,
				    finished_at = COALESCE(finished_at, $1), updated_at = $1
				WHERE id = $3::uuid
			`, now, errRaw, row.step); err != nil {
				return 0, mapDBErr(err)
			}
			if err := parkedapproval.CancelUnresolvable(ctx, tx, row.exec, row.nodeID, now); err != nil {
				return 0, mapDBErr(err)
			}
			failPairs = append(failPairs, recoverPair{exec: row.exec, step: row.step})
			continue
		}
		if row.pending {
			tag, err := tx.Exec(ctx, `
				UPDATE execution_jobs
				SET status = 'waiting', worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL, updated_at = $1
				WHERE id = $2::uuid AND status IN ('claimed', 'running')
			`, now, row.jobID)
			if err != nil {
				return 0, mapDBErr(err)
			}
			if tag.RowsAffected() == 0 {
				continue
			}
			if _, err := tx.Exec(ctx, `
				UPDATE execution_steps
				SET status = 'waiting', lease_id = NULL, finished_at = NULL, updated_at = $1
				WHERE id = $2::uuid
			`, now, row.step); err != nil {
				return 0, mapDBErr(err)
			}
			parkPairs = append(parkPairs, recoverPair{exec: row.exec, step: row.step})
			continue
		}
		tag, err := tx.Exec(ctx, `
			UPDATE execution_jobs
			SET status = 'queued', worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
			    available_at = $3, updated_at = $1
			WHERE id = $2::uuid AND status IN ('claimed', 'running')
		`, now, row.jobID, available)
		if err != nil {
			return 0, mapDBErr(err)
		}
		if tag.RowsAffected() == 0 {
			continue
		}
		if _, err := tx.Exec(ctx, `
			UPDATE execution_steps
			SET status = 'queued', lease_id = NULL, finished_at = NULL, updated_at = $1
			WHERE id = $2::uuid
		`, now, row.step); err != nil {
			return 0, mapDBErr(err)
		}
		requeuePairs = append(requeuePairs, recoverPair{exec: row.exec, step: row.step})
	}
	if err := finishRecoverPairs(ctx, tx, scope, now, failPairs, "failed"); err != nil {
		return 0, err
	}
	if err := finishRecoverPairs(ctx, tx, scope, now, parkPairs, "waiting"); err != nil {
		return 0, err
	}
	if err := finishRecoverPairs(ctx, tx, scope, now, requeuePairs, "requeued"); err != nil {
		return 0, err
	}
	return len(failPairs) + len(parkPairs) + len(requeuePairs), nil
}

func expiredLeaseExecutions(ctx context.Context, tx pgx.Tx, now time.Time) (execIDs, workflowIDs []string, err error) {
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT e.workflow_id::text, j.execution_id::text
		FROM execution_jobs j
		JOIN executions e ON e.workspace_id = j.workspace_id AND e.id = j.execution_id
		WHERE j.status IN ('claimed', 'running')
		  AND j.lease_expires_at IS NOT NULL
		  AND j.lease_expires_at <= $1
	`, now)
	if err != nil {
		return nil, nil, mapDBErr(err)
	}
	defer rows.Close()
	for rows.Next() {
		var workflowID, execID string
		if err := rows.Scan(&workflowID, &execID); err != nil {
			return nil, nil, mapDBErr(err)
		}
		workflowIDs = append(workflowIDs, workflowID)
		execIDs = append(execIDs, execID)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, mapDBErr(err)
	}
	return execIDs, workflowIDs, nil
}

func loadDueWaits(ctx context.Context, tx pgx.Tx, now time.Time) ([]dueWaitRow, error) {
	rows, err := tx.Query(ctx, `
		SELECT e.workflow_id::text, j.execution_id::text, j.execution_step_id::text, s.node_type
		FROM execution_jobs j
		JOIN executions e ON e.workspace_id = j.workspace_id AND e.id = j.execution_id
		JOIN execution_steps s ON s.workspace_id = j.workspace_id AND s.id = j.execution_step_id
		WHERE j.status = 'waiting' AND j.available_at <= $1
	`, now)
	if err != nil {
		return nil, mapDBErr(err)
	}
	defer rows.Close()
	var out []dueWaitRow
	for rows.Next() {
		var row dueWaitRow
		if err := rows.Scan(&row.workflowID, &row.exec, &row.step, &row.nodeType); err != nil {
			return nil, mapDBErr(err)
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return out, nil
}

func lockWorkflowsSorted(ctx context.Context, tx pgx.Tx, workflowIDs []string) (map[string]struct{}, error) {
	seen := map[string]struct{}{}
	var order []string
	for _, workflowID := range workflowIDs {
		if workflowID == "" {
			continue
		}
		if _, ok := seen[workflowID]; ok {
			continue
		}
		seen[workflowID] = struct{}{}
		order = append(order, workflowID)
	}
	sort.Strings(order)
	deleted := map[string]struct{}{}
	for _, workflowID := range order {
		err := lockLiveWorkflow(ctx, tx, workflowID)
		if errors.Is(err, ErrNotFound) {
			deleted[workflowID] = struct{}{}
			continue
		}
		if err != nil {
			return nil, err
		}
	}
	return deleted, nil
}

type dueWaitRow struct {
	workflowID string
	exec       string
	step       string
	nodeType   string
}

// resumeOrStopDueWaits finishes waiting timers whose parent workflow was
// already locked. A tombstone fails the run and does not write an expired
// port. Workflow ids are handled in sorted order. Execution rows are
// already locked by recoverExpiredTx.
func resumeOrStopDueWaits(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, rows []dueWaitRow, deleted map[string]struct{}) (stopped, resumed int, err error) {
	byWorkflow := map[string][]dueWaitRow{}
	var order []string
	for _, row := range rows {
		if _, ok := byWorkflow[row.workflowID]; !ok {
			order = append(order, row.workflowID)
		}
		byWorkflow[row.workflowID] = append(byWorkflow[row.workflowID], row)
	}
	sort.Strings(order)
	for _, workflowID := range order {
		if _, gone := deleted[workflowID]; gone {
			seen := map[string]struct{}{}
			for _, row := range byWorkflow[workflowID] {
				if _, ok := seen[row.exec]; ok {
					continue
				}
				seen[row.exec] = struct{}{}
				if stopErr := stopExecutionWorkflowDeletedTx(ctx, tx, scope, now, row.exec); stopErr != nil {
					return 0, 0, stopErr
				}
				stopped++
			}
			continue
		}
		if err := lockLiveWorkflow(ctx, tx, workflowID); err != nil {
			if errors.Is(err, ErrNotFound) {
				seen := map[string]struct{}{}
				for _, row := range byWorkflow[workflowID] {
					if _, ok := seen[row.exec]; ok {
						continue
					}
					seen[row.exec] = struct{}{}
					if stopErr := stopExecutionWorkflowDeletedTx(ctx, tx, scope, now, row.exec); stopErr != nil {
						return 0, 0, stopErr
					}
					stopped++
				}
				continue
			}
			return 0, 0, err
		}
		var expPairs []recoverPair
		outcome := "result"
		for _, row := range byWorkflow[workflowID] {
			port := waitExpiryPort(row.nodeType)
			if port == "expired" {
				outcome = "expired"
			}
			payload, err := marshalObject(waitOutput(port, nil))
			if err != nil {
				return 0, 0, ErrInvalid
			}
			if err := lockExecutionTx(ctx, tx, row.exec); err != nil {
				return 0, 0, err
			}
			tag, err := tx.Exec(ctx, `
				UPDATE execution_jobs
				SET status = 'succeeded', updated_at = $1
				WHERE execution_step_id = $2::uuid AND status = 'waiting'
			`, now, row.step)
			if err != nil {
				return 0, 0, mapDBErr(err)
			}
			if tag.RowsAffected() == 0 {
				continue
			}
			step, err := scanStep(tx.QueryRow(ctx, `
				UPDATE execution_steps
				SET status = 'succeeded', output_redacted = $2::jsonb, finished_at = COALESCE(finished_at, $1), updated_at = $1
				WHERE id = $3::uuid
				RETURNING `+stepColumns, now, payload, row.step))
			if err != nil {
				return 0, 0, err
			}
			if err := resolveOutgoingTx(ctx, tx, row.exec, step.NodeID, emittedPorts(step.NodeType, step.Output), now); err != nil {
				return 0, 0, err
			}
			if port == "expired" {
				if err := expireParkedGateTx(ctx, tx, row.exec, step.NodeID, now); err != nil {
					return 0, 0, err
				}
			}
			expPairs = append(expPairs, recoverPair{exec: row.exec, step: row.step})
			resumed++
		}
		if err := finishRecoverPairs(ctx, tx, scope, now, expPairs, outcome); err != nil {
			return 0, 0, err
		}
	}
	return stopped, resumed, nil
}

type recoverPair struct{ exec, step string }

func collectRecoverPairs(rows pgx.Rows) ([]recoverPair, error) {
	defer rows.Close()
	var pairs []recoverPair
	for rows.Next() {
		var p recoverPair
		if err := rows.Scan(&p.exec, &p.step); err != nil {
			return nil, mapDBErr(err)
		}
		pairs = append(pairs, p)
	}
	if err := rows.Err(); err != nil {
		return nil, mapDBErr(err)
	}
	return pairs, nil
}

func finishRecoverPairs(ctx context.Context, tx pgx.Tx, scope isolation.Scope, now time.Time, pairs []recoverPair, outcome string) error {
	seen := map[string]struct{}{}
	for _, p := range pairs {
		if _, ok := seen[p.exec]; ok {
			continue
		}
		seen[p.exec] = struct{}{}
		if err := rollupExecutionTx(ctx, tx, p.exec, now); err != nil {
			return err
		}
		if _, err := insertAuditTx(ctx, tx, scope, AuditWrite{
			Action:       "job.recover",
			ResourceType: "execution",
			ResourceID:   p.exec,
			Outcome:      outcome,
			Details:      map[string]any{"reason": "lease-expired"},
		}); err != nil {
			return err
		}
	}
	return nil
}

func rollupExecutionTx(ctx context.Context, tx pgx.Tx, executionID string, now time.Time) error {
	exec, err := getExecutionTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	if exec.Status == ExecutionCanceled {
		return nil
	}
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
	steps, err := loadStepsTx(ctx, tx, executionID)
	if err != nil {
		return err
	}
	next := guardCanceledRollup(exec.Status, rollupExecutionStatus(jobs, steps))
	return applyExecutionStatusTx(ctx, tx, executionID, next, now)
}

func applyExecutionStatusTx(ctx context.Context, tx pgx.Tx, executionID, status string, now time.Time) error {
	_, err := tx.Exec(ctx, `
		UPDATE executions
		SET status = $2,
		    started_at = CASE WHEN $2 = 'running' THEN COALESCE(started_at, $1) ELSE started_at END,
		    finished_at = CASE WHEN $2 IN ('succeeded', 'failed', 'canceled', 'indeterminate') THEN COALESCE(finished_at, $1)
		                       WHEN $2 IN ('queued', 'running', 'waiting') THEN NULL
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
