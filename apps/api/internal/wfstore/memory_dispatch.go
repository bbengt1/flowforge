package wfstore

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
)

func (m *Memory) GetJob(_ context.Context, scope isolation.Scope, jobID string) (ExecutionJob, error) {
	if scope.Zero() {
		return ExecutionJob{}, ErrNoScope
	}
	if !authz.ValidUUID(jobID) {
		return ExecutionJob{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	_, job, ok := m.lookupJobLocked(scope.WorkspaceID(), jobID)
	if !ok {
		return ExecutionJob{}, ErrNotFound
	}
	return cloneJob(job), nil
}

func (m *Memory) ClaimJob(ctx context.Context, scope isolation.Scope, now time.Time, in ClaimInput) (DispatchResult, error) {
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

	m.mu.Lock()
	candidates := m.expiredApprovalCandidatesLocked(scope, now)
	m.mu.Unlock()
	pending := m.approvalPendingSnapshot(candidates)
	m.mu.Lock()
	defer m.mu.Unlock()
	recovered := m.recoverExpiredLocked(ctx, scope, now, pending)

	var chosen *memExecution
	jobIdx := -1
	for id, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() {
			continue
		}
		if !executionIsActive(exec.record.Status) {
			continue
		}
		for i, job := range exec.jobs {
			if job.Status != JobQueued || job.Status == JobBlocked || job.AvailableAt.After(now) {
				continue
			}
			stepIdx := indexStep(exec.steps, job.ExecutionStepID)
			if stepIdx < 0 || exec.steps[stepIdx].UnresolvedIncoming != 0 {
				continue
			}
			if hasActiveClaim(exec.jobs, job.ExecutionStepID, i) {
				continue
			}
			row := exec
			chosen = &row
			chosenID := id
			_ = chosenID
			jobIdx = i
			break
		}
		if chosen != nil {
			break
		}
	}
	if chosen == nil || jobIdx < 0 {
		observability.NoteLeaseClaim(ctx, "empty", 0)
		if recovered > 0 {
			return DispatchResult{Recovered: recovered}, ErrEmptyClaim
		}
		return DispatchResult{}, ErrEmptyClaim
	}
	pickedJobID := chosen.jobs[jobIdx].ID
	if err := m.guardLiveLocked(ctx, scope, now, chosen.record.WorkflowID, chosen.record.ID); err != nil {
		if errors.Is(err, ErrWorkflowDeleted) {
			observability.NoteLeaseClaim(ctx, "empty", 0)
			return DispatchResult{Recovered: recovered}, ErrEmptyClaim
		}
		return DispatchResult{}, err
	}
	chosenRow := m.executions[chosen.record.ID]
	chosen = &chosenRow
	jobIdx = indexJob(chosen.jobs, pickedJobID)
	if jobIdx < 0 || chosen.jobs[jobIdx].Status != JobQueued {
		observability.NoteLeaseClaim(ctx, "empty", 0)
		return DispatchResult{Recovered: recovered}, ErrEmptyClaim
	}
	if stepIdx := indexStep(chosen.steps, chosen.jobs[jobIdx].ExecutionStepID); stepIdx < 0 || chosen.steps[stepIdx].UnresolvedIncoming != 0 {
		observability.NoteLeaseClaim(ctx, "empty", 0)
		return DispatchResult{Recovered: recovered}, ErrEmptyClaim
	}

	leaseExp := now.Add(lease)
	job := chosen.jobs[jobIdx]
	job.Status = JobClaimed
	job.WorkerID = workerID
	job.FencingToken++
	job.LeaseExpiresAt = &leaseExp
	job.HeartbeatAt = nil
	job.UpdatedAt = now
	chosen.jobs[jobIdx] = job

	stepIdx := indexStep(chosen.steps, job.ExecutionStepID)
	if stepIdx < 0 {
		return DispatchResult{}, ErrNotFound
	}
	step := chosen.steps[stepIdx]
	step.LeaseID = job.ID
	step.FencingToken = job.FencingToken
	applyStepStatus(&step, ExecutionRunning, now)
	chosen.steps[stepIdx] = step

	applyExecutionStatus(&chosen.record, ExecutionRunning, now)
	m.executions[chosen.record.ID] = *chosen
	m.appendAuditLocked(scope, AuditWrite{
		Action:        "job.claim",
		ResourceType:  "execution",
		ResourceID:    chosen.record.ID,
		Outcome:       "claimed",
		CorrelationID: chosen.record.CorrelationID,
		Details:       map[string]any{"jobId": job.ID, "workerId": workerID, "fencingToken": job.FencingToken},
	}, now)

	wf := m.workflows[chosen.record.WorkflowID]
	binding := buildBinding(scope, chosen.record, step, job, now.Add(ttl), leaseExp)
	observability.NoteLeaseClaim(ctx, "claimed", now.Sub(job.AvailableAt))
	observability.NoteQueueLeft(ctx, 1)
	return DispatchResult{
		Execution: cloneExecution(chosen.record, wf.record),
		Step:      cloneStep(step),
		Job:       cloneJob(job),
		Binding:   binding,
		Recovered: recovered,
	}, nil
}

func (m *Memory) HeartbeatJob(_ context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return m.mutateJob(scope, now, in, func(exec *memExecution, job *ExecutionJob, step *ExecutionStep) error {
		if err := matchFence(*job, in); err != nil {
			return err
		}
		if err := requireActiveLease(*job, now); err != nil {
			return err
		}
		if exec.record.Status == ExecutionCanceled {
			return ErrCanceled
		}
		lease := normalizeLease(in.Lease)
		leaseExp := now.Add(lease)
		job.Status = JobRunning
		job.LeaseExpiresAt = &leaseExp
		hb := now
		job.HeartbeatAt = &hb
		job.UpdatedAt = now
		applyStepStatus(step, ExecutionRunning, now)
		return nil
	}, "job.heartbeat", "heartbeat")
}

func (m *Memory) ReleaseJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return m.mutateJob(scope, now, in, func(exec *memExecution, job *ExecutionJob, step *ExecutionStep) error {
		if err := matchFence(*job, in); err != nil {
			return err
		}
		if err := requireActiveLease(*job, now); err != nil {
			return err
		}
		if job.Status == JobRunning || job.HeartbeatAt != nil {
			// Worker already passed the provider fence; fail closed.
			job.Status = JobIndeterminate
			job.UpdatedAt = now
			applyStepStatus(step, ExecutionIndeterminate, now)
			return nil
		}
		if err := m.guardLiveLocked(ctx, scope, now, exec.record.WorkflowID, exec.record.ID); err != nil {
			return err
		}
		job.Status = JobQueued
		job.WorkerID = ""
		job.LeaseExpiresAt = nil
		job.HeartbeatAt = nil
		job.UpdatedAt = now
		if in.ApprovalTransientRetry {
			job.AvailableAt = now.Add(approvalRetryWait(approvalJitter()))
		}
		step.LeaseID = ""
		applyStepStatus(step, ExecutionQueued, now)
		return nil
	}, "job.release", "released")
}

func (m *Memory) CompleteJob(_ context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return m.mutateJob(scope, now, in, func(exec *memExecution, job *ExecutionJob, step *ExecutionStep) error {
		if job.Status == JobSucceeded && matchFence(*job, in) == nil {
			return nil
		}
		if err := matchFence(*job, in); err != nil {
			return err
		}
		if err := requireActiveLease(*job, now); err != nil {
			return err
		}
		if exec.record.Status == ExecutionCanceled {
			return ErrCanceled
		}
		job.Status = JobSucceeded
		job.UpdatedAt = now
		step.Output = redactObject(in.Output)
		if step.Output == nil {
			step.Output = map[string]any{}
		}
		applyStepStatus(step, ExecutionSucceeded, now)
		releaseFrom(exec.steps, exec.jobs, exec.edges, step.NodeID, emittedPorts(step.NodeType, step.Output), now)
		return nil
	}, "job.complete", "succeeded")
}

func (m *Memory) FailJob(_ context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
	return m.mutateJob(scope, now, in, func(exec *memExecution, job *ExecutionJob, step *ExecutionStep) error {
		if job.Status == JobFailed && matchFence(*job, in) == nil {
			return nil
		}
		if err := matchFence(*job, in); err != nil {
			return err
		}
		if err := requireActiveLease(*job, now); err != nil {
			return err
		}
		job.Status = JobFailed
		job.UpdatedAt = now
		step.Error = redactObject(in.Error)
		if step.Error == nil {
			step.Error = map[string]any{}
		}
		applyStepStatus(step, ExecutionFailed, now)
		return nil
	}, "job.fail", "failed")
}

func (m *Memory) CancelExecution(ctx context.Context, scope isolation.Scope, now time.Time, executionID string) (Execution, error) {
	if scope.Zero() {
		return Execution{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) {
		return Execution{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return Execution{}, ErrNotFound
	}
	if exec.record.Status == ExecutionCanceled {
		wf := m.workflows[exec.record.WorkflowID]
		return cloneExecution(exec.record, wf.record), nil
	}
	if isTerminalExecution(exec.record.Status) && exec.record.Status != ExecutionPinned {
		return Execution{}, ErrAlreadyTerminal
	}
	queued := 0
	for i := range exec.jobs {
		if exec.jobs[i].Status == JobQueued {
			queued++
		}
		if jobIsOpen(exec.jobs[i].Status) {
			exec.jobs[i].Status = JobCanceled
			exec.jobs[i].UpdatedAt = now
		}
	}
	observability.NoteQueueLeft(ctx, queued)
	observability.NoteExecutionOutcome(ctx, "canceled")
	for i := range exec.steps {
		switch exec.steps[i].Status {
		case ExecutionPending, ExecutionQueued, ExecutionRunning, ExecutionWaiting:
			applyStepStatus(&exec.steps[i], ExecutionCanceled, now)
		}
	}
	applyExecutionStatus(&exec.record, ExecutionCanceled, now)
	m.executions[executionID] = exec
	m.appendAuditLocked(scope, AuditWrite{
		Action:        "execution.cancel",
		ResourceType:  "execution",
		ResourceID:    executionID,
		Outcome:       "canceled",
		CorrelationID: exec.record.CorrelationID,
	}, now)
	wf := m.workflows[exec.record.WorkflowID]
	return cloneExecution(exec.record, wf.record), nil
}

func (m *Memory) EmergencyStop(_ context.Context, scope isolation.Scope, now time.Time, in EmergencyStopInput) (EmergencyStopResult, error) {
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
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[in.ExecutionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return EmergencyStopResult{}, ErrNotFound
	}
	stopped := 0
	uncertain := false
	matched := 0
	for i := range exec.steps {
		step := &exec.steps[i]
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
		jidx := -1
		for j := range exec.jobs {
			if exec.jobs[j].ExecutionStepID == step.ID && (jobIsOpen(exec.jobs[j].Status) || exec.jobs[j].Status == JobIndeterminate) {
				jidx = j
				if jobIsOpen(exec.jobs[j].Status) {
					break
				}
			}
		}
		if jidx < 0 {
			continue
		}
		job := exec.jobs[jidx]
		if !jobIsOpen(job.Status) {
			if job.Status == JobIndeterminate {
				uncertain = true
			}
			continue
		}
		next := emergencyStopJobStatus(job, in.Uncertain)
		job.Status = next
		job.UpdatedAt = now
		exec.jobs[jidx] = job
		applyStepStatus(step, emergencyStopStepStatus(next), now)
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
		if exec.record.Status == ExecutionIndeterminate {
			wf := m.workflows[exec.record.WorkflowID]
			return EmergencyStopResult{
				Execution: cloneExecution(exec.record, wf.record),
				Outcome:   ExecutionIndeterminate,
				Uncertain: true,
			}, nil
		}
		if isTerminalExecution(exec.record.Status) && exec.record.Status != ExecutionPinned {
			return EmergencyStopResult{}, ErrAlreadyTerminal
		}
		return EmergencyStopResult{}, ErrEmergencyStopNotApplicable
	}
	m.rollupLocked(&exec, now)
	m.executions[in.ExecutionID] = exec
	outcome := exec.record.Status
	if uncertain {
		outcome = ExecutionIndeterminate
	}
	m.appendAuditLocked(scope, AuditWrite{
		Action:        scripts.AuditEmergencyStop,
		ResourceType:  "execution",
		ResourceID:    in.ExecutionID,
		Outcome:       outcome,
		CorrelationID: exec.record.CorrelationID,
		Details:       scripts.EmergencyStopAudit(in.ExecutionID, in.StepID, "", outcome, scope.ActorID(), uncertain || in.Uncertain),
	}, now)
	wf := m.workflows[exec.record.WorkflowID]
	return EmergencyStopResult{
		Execution: cloneExecution(exec.record, wf.record),
		Outcome:   outcome,
		Uncertain: uncertain || in.Uncertain,
		Stopped:   stopped,
	}, nil
}

func (m *Memory) RetryStep(ctx context.Context, scope isolation.Scope, now time.Time, executionID, stepID string, hint ...map[string]any) (RetryResult, error) {
	if scope.Zero() {
		return RetryResult{}, ErrNoScope
	}
	if !authz.ValidUUID(executionID) || !authz.ValidUUID(stepID) {
		return RetryResult{}, ErrNotFound
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	exec, ok := m.executions[executionID]
	if !ok || exec.workspaceID != scope.WorkspaceID() {
		return RetryResult{}, ErrNotFound
	}
	stepIdx := indexStep(exec.steps, stepID)
	if stepIdx < 0 {
		return RetryResult{}, ErrNotFound
	}
	src := exec.steps[stepIdx]
	if err := m.guardLiveLocked(ctx, scope, now, exec.record.WorkflowID, executionID); err != nil {
		if errors.Is(err, ErrWorkflowDeleted) {
			return RetryResult{}, &NotRetryableError{Reason: ReasonWorkflowDeleted}
		}
		return RetryResult{}, err
	}
	exec = m.executions[executionID]
	stepIdx = indexStep(exec.steps, stepID)
	if stepIdx < 0 {
		return RetryResult{}, ErrNotFound
	}
	src = exec.steps[stepIdx]
	if err := retryStatusError(exec.record, src, exec.steps); err != nil {
		return RetryResult{}, err
	}
	if len(hint) > 0 {
		applyRetryHint(&src, hint[0])
	}
	if err := canRetryStep(src); err != nil {
		return RetryResult{}, err
	}
	unresolved, err := incomingRetryError(src.NodeID, exec.edges)
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
	observability.NoteJobEnqueued(ctx, 1)
	exec.steps = append(exec.steps, next)
	exec.jobs = append(exec.jobs, job)
	m.rollupLocked(&exec, now)
	m.executions[executionID] = exec
	m.appendAuditLocked(scope, AuditWrite{
		Action:        "execution.retry",
		ResourceType:  "execution",
		ResourceID:    executionID,
		Outcome:       "queued",
		CorrelationID: exec.record.CorrelationID,
		Details:       map[string]any{"stepId": next.ID, "attempt": next.Attempt, "nodeId": next.NodeID},
	}, now)
	wf := m.workflows[exec.record.WorkflowID]
	return RetryResult{
		Execution: cloneExecution(exec.record, wf.record),
		Step:      cloneStep(next),
		Job:       cloneJob(job),
	}, nil
}

func (m *Memory) RecoverExpiredLeases(ctx context.Context, scope isolation.Scope, now time.Time) (int, error) {
	if scope.Zero() {
		return 0, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	candidates := m.expiredApprovalCandidatesLocked(scope, now)
	m.mu.Unlock()
	// HasPending takes the approval lock. Decide takes that lock and then
	// this store's lock, so the pending check cannot run while this lock
	// is held.
	pending := m.approvalPendingSnapshot(candidates)
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.recoverExpiredLocked(ctx, scope, now, pending), nil
}

func (m *Memory) approvalPendingSnapshot(candidates []expiredApprovalCandidate) map[string]bool {
	pending := map[string]bool{}
	for _, candidate := range candidates {
		if m.approvalPending == nil {
			pending[candidate.jobID] = false
			continue
		}
		pending[candidate.jobID] = m.approvalPending(candidate.execID, candidate.nodeID)
	}
	return pending
}

type expiredApprovalCandidate struct {
	jobID  string
	execID string
	nodeID string
}

func (m *Memory) expiredApprovalCandidatesLocked(scope isolation.Scope, now time.Time) []expiredApprovalCandidate {
	var out []expiredApprovalCandidate
	for _, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() {
			continue
		}
		for _, job := range exec.jobs {
			if !jobIsWritable(job.Status) || job.LeaseExpiresAt == nil || now.Before(*job.LeaseExpiresAt) {
				continue
			}
			stepIdx := indexStep(exec.steps, job.ExecutionStepID)
			if stepIdx < 0 || exec.steps[stepIdx].NodeType != "flow.approval" {
				continue
			}
			out = append(out, expiredApprovalCandidate{
				jobID:  job.ID,
				execID: exec.record.ID,
				nodeID: exec.steps[stepIdx].NodeID,
			})
		}
	}
	return out
}

func (m *Memory) WaitJob(_ context.Context, scope isolation.Scope, now time.Time, in WaitJobInput) (DispatchResult, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return m.mutateWait(scope, now, in.JobID, func(exec *memExecution, job *ExecutionJob, step *ExecutionStep) error {
		if job.Status == JobWaiting {
			return nil
		}
		if job.Status != JobClaimed && job.Status != JobRunning && job.Status != JobQueued {
			return ErrNotClaimable
		}
		if exec.record.Status == ExecutionCanceled {
			return ErrCanceled
		}
		job.Status = JobWaiting
		job.WorkerID = ""
		job.LeaseExpiresAt = nil
		job.HeartbeatAt = nil
		if !in.AvailableAt.IsZero() {
			job.AvailableAt = in.AvailableAt.UTC()
		}
		job.UpdatedAt = now
		step.LeaseID = ""
		applyStepStatus(step, ExecutionWaiting, now)
		return nil
	}, "job.wait", "waiting")
}

func (m *Memory) ResumeWait(ctx context.Context, scope isolation.Scope, now time.Time, in ResumeWaitInput) (DispatchResult, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	port := strings.TrimSpace(in.Port)
	if port == "" {
		port = "expired"
	}
	return m.mutateWait(scope, now, in.JobID, func(exec *memExecution, job *ExecutionJob, step *ExecutionStep) error {
		if job.Status == JobSucceeded {
			return nil
		}
		// A tombstone is checked before the waiting-status check so a gate
		// delete already canceled still returns ErrWorkflowDeleted and does
		// not write a port. That matches the postgres resume path.
		if err := m.guardLiveLocked(ctx, scope, now, exec.record.WorkflowID, exec.record.ID); err != nil {
			return err
		}
		if job.Status != JobWaiting {
			return ErrNotClaimable
		}
		job.Status = JobSucceeded
		job.UpdatedAt = now
		step.Output = redactObject(waitOutput(port, in.Output))
		if step.Output == nil {
			step.Output = waitOutput(port, nil)
		}
		applyStepStatus(step, ExecutionSucceeded, now)
		releaseFrom(exec.steps, exec.jobs, exec.edges, step.NodeID, emittedPorts(step.NodeType, step.Output), now)
		return nil
	}, "job.resume", port)
}

func (m *Memory) mutateWait(scope isolation.Scope, now time.Time, jobID string, fn func(*memExecution, *ExecutionJob, *ExecutionStep) error, action, outcome string) (DispatchResult, error) {
	if scope.Zero() {
		return DispatchResult{}, ErrNoScope
	}
	if !authz.ValidUUID(jobID) {
		return DispatchResult{}, ErrNotFound
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	execID, job, ok := m.lookupJobLocked(scope.WorkspaceID(), jobID)
	if !ok {
		return DispatchResult{}, ErrNotFound
	}
	exec := m.executions[execID]
	jobIdx := indexJob(exec.jobs, jobID)
	stepIdx := indexStep(exec.steps, job.ExecutionStepID)
	if jobIdx < 0 || stepIdx < 0 {
		return DispatchResult{}, ErrNotFound
	}
	job = exec.jobs[jobIdx]
	step := exec.steps[stepIdx]
	if err := fn(&exec, &job, &step); err != nil {
		return DispatchResult{}, err
	}
	exec.jobs[jobIdx] = job
	exec.steps[stepIdx] = step
	m.rollupLocked(&exec, now)
	m.executions[execID] = exec
	m.appendAuditLocked(scope, AuditWrite{
		Action:        action,
		ResourceType:  "execution",
		ResourceID:    exec.record.ID,
		Outcome:       outcome,
		CorrelationID: exec.record.CorrelationID,
		Details:       map[string]any{"jobId": job.ID, "nodeId": step.NodeID},
	}, now)
	wf := m.workflows[exec.record.WorkflowID]
	leaseExp := now
	if job.LeaseExpiresAt != nil {
		leaseExp = *job.LeaseExpiresAt
	}
	observability.NoteExecutionOutcome(context.Background(), outcome)
	return DispatchResult{
		Execution: cloneExecution(exec.record, wf.record),
		Step:      cloneStep(step),
		Job:       cloneJob(job),
		Binding:   buildBinding(scope, exec.record, step, job, now.Add(DefaultJobBindingTTL), leaseExp),
	}, nil
}

func (m *Memory) mutateJob(scope isolation.Scope, now time.Time, in JobActionInput, fn func(*memExecution, *ExecutionJob, *ExecutionStep) error, action, outcome string) (DispatchResult, error) {
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
	m.mu.Lock()
	defer m.mu.Unlock()
	execID, job, ok := m.lookupJobLocked(scope.WorkspaceID(), in.JobID)
	if !ok {
		return DispatchResult{}, ErrNotFound
	}
	exec := m.executions[execID]
	jobIdx := indexJob(exec.jobs, in.JobID)
	stepIdx := indexStep(exec.steps, job.ExecutionStepID)
	if jobIdx < 0 || stepIdx < 0 {
		return DispatchResult{}, ErrNotFound
	}
	job = exec.jobs[jobIdx]
	step := exec.steps[stepIdx]
	if err := fn(&exec, &job, &step); err != nil {
		return DispatchResult{}, err
	}
	exec.jobs[jobIdx] = job
	exec.steps[stepIdx] = step
	m.rollupLocked(&exec, now)
	m.executions[execID] = exec
	m.appendAuditLocked(scope, AuditWrite{
		Action:        action,
		ResourceType:  "execution",
		ResourceID:    exec.record.ID,
		Outcome:       outcome,
		CorrelationID: exec.record.CorrelationID,
		Details:       map[string]any{"jobId": job.ID, "fencingToken": job.FencingToken},
	}, now)
	wf := m.workflows[exec.record.WorkflowID]
	leaseExp := now
	if job.LeaseExpiresAt != nil {
		leaseExp = *job.LeaseExpiresAt
	}
	return DispatchResult{
		Execution: cloneExecution(exec.record, wf.record),
		Step:      cloneStep(step),
		Job:       cloneJob(job),
		Binding:   buildBinding(scope, exec.record, step, job, now.Add(DefaultJobBindingTTL), leaseExp),
	}, nil
}

func (m *Memory) recoverExpiredLocked(ctx context.Context, scope isolation.Scope, now time.Time, approvalPending map[string]bool) int {
	n := 0
	expiredLeases := 0
	hooked := map[string]struct{}{}
	for id, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() {
			continue
		}
		due := false
		for _, job := range exec.jobs {
			if job.Status == JobWaiting && !job.AvailableAt.After(now) {
				due = true
				break
			}
		}
		if due {
			if _, live := m.liveLocked(scope, exec.record.WorkflowID); !live {
				if err := m.stopExecutionLocked(scope, now, exec.record.ID); err == nil {
					n++
				}
				continue
			}
			if _, ok := hooked[exec.record.WorkflowID]; !ok {
				runWorkflowRowLockHook(ctx)
				hooked[exec.record.WorkflowID] = struct{}{}
			}
		}
		changed := false
		outcome := "indeterminate"
		for i, job := range exec.jobs {
			stepIdx := indexStep(exec.steps, job.ExecutionStepID)
			if job.Status == JobWaiting && !job.AvailableAt.After(now) {
				port := "expired"
				nodeID := ""
				if stepIdx >= 0 {
					port = waitExpiryPort(exec.steps[stepIdx].NodeType)
					nodeID = exec.steps[stepIdx].NodeID
				}
				job.Status = JobSucceeded
				job.UpdatedAt = now
				exec.jobs[i] = job
				if stepIdx >= 0 {
					exec.steps[stepIdx].Output = waitOutput(port, nil)
					applyStepStatus(&exec.steps[stepIdx], ExecutionSucceeded, now)
					releaseFrom(exec.steps, exec.jobs, exec.edges, nodeID, emittedPorts(exec.steps[stepIdx].NodeType, exec.steps[stepIdx].Output), now)
				}
				changed = true
				outcome = port
				n++
				continue
			}
			if !jobIsWritable(job.Status) || job.LeaseExpiresAt == nil || now.Before(*job.LeaseExpiresAt) {
				continue
			}
			if stepIdx >= 0 && exec.steps[stepIdx].NodeType == "flow.approval" {
				known, ok := approvalPending[job.ID]
				if !ok {
					continue
				}
				if ApprovalPastLimit(job.CreatedAt, exec.steps[stepIdx].Input, now) {
					job.Status = JobFailed
					job.WorkerID = ""
					job.LeaseExpiresAt = nil
					job.HeartbeatAt = nil
					job.UpdatedAt = now
					exec.jobs[i] = job
					exec.steps[stepIdx].Error = requirementUnresolvableStepError()
					exec.steps[stepIdx].LeaseID = ""
					applyStepStatus(&exec.steps[stepIdx], ExecutionFailed, now)
					changed = true
					outcome = "failed"
					n++
					continue
				}
				if !known {
					job.Status = JobQueued
					job.WorkerID = ""
					job.LeaseExpiresAt = nil
					job.HeartbeatAt = nil
					job.AvailableAt = now.Add(approvalRetryWait(approvalJitter()))
					job.UpdatedAt = now
					exec.jobs[i] = job
					exec.steps[stepIdx].LeaseID = ""
					applyStepStatus(&exec.steps[stepIdx], ExecutionQueued, now)
					changed = true
					outcome = "requeued"
					n++
					continue
				}
				job.Status = JobWaiting
				job.WorkerID = ""
				job.LeaseExpiresAt = nil
				job.HeartbeatAt = nil
				job.UpdatedAt = now
				exec.jobs[i] = job
				applyStepStatus(&exec.steps[stepIdx], ExecutionWaiting, now)
				exec.steps[stepIdx].LeaseID = ""
				changed = true
				outcome = "waiting"
				n++
				continue
			}
			job.Status = JobIndeterminate
			job.UpdatedAt = now
			exec.jobs[i] = job
			if stepIdx >= 0 {
				applyStepStatus(&exec.steps[stepIdx], ExecutionIndeterminate, now)
			}
			changed = true
			n++
			expiredLeases++
		}
		if changed {
			m.rollupLocked(&exec, now)
			m.executions[id] = exec
			m.appendAuditLocked(scope, AuditWrite{
				Action:        "job.recover",
				ResourceType:  "execution",
				ResourceID:    exec.record.ID,
				Outcome:       outcome,
				CorrelationID: exec.record.CorrelationID,
				Details:       map[string]any{"reason": "lease-expired"},
			}, now)
		}
	}
	observability.NoteLeaseExpired(context.Background(), expiredLeases)
	for range expiredLeases {
		observability.NoteExecutionOutcome(context.Background(), "indeterminate")
	}
	return n
}

func (m *Memory) rollupLocked(exec *memExecution, now time.Time) {
	if exec.record.Status == ExecutionCanceled {
		return
	}
	next := guardCanceledRollup(exec.record.Status, rollupExecutionStatus(exec.jobs, exec.steps))
	applyExecutionStatus(&exec.record, next, now)
}

func (m *Memory) AnnotateRetryCapabilities(_ context.Context, scope isolation.Scope, exec *Execution, steps []ExecutionStep) error {
	if scope.Zero() {
		return ErrNoScope
	}
	if exec == nil {
		return ErrInvalid
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	row, ok := m.executions[exec.ID]
	if !ok || row.workspaceID != scope.WorkspaceID() {
		return ErrNotFound
	}
	wf, ok := m.workflows[row.record.WorkflowID]
	deleted := !ok || wf.workspaceID != scope.WorkspaceID() || wf.deletedAt != nil
	applyRetryCapabilities(exec, steps, row.edges, deleted)
	return nil
}

func (m *Memory) lookupJobLocked(workspaceID, jobID string) (string, ExecutionJob, bool) {
	for id, exec := range m.executions {
		if exec.workspaceID != workspaceID {
			continue
		}
		for _, job := range exec.jobs {
			if job.ID == jobID {
				return id, job, true
			}
		}
	}
	return "", ExecutionJob{}, false
}

func (m *Memory) appendAuditLocked(scope isolation.Scope, in AuditWrite, now time.Time) {
	m.audits = append(m.audits, memAudit{workspaceID: scope.WorkspaceID(), record: newAudit(scope, in, now)})
}

func indexJob(jobs []ExecutionJob, id string) int {
	for i, job := range jobs {
		if job.ID == id {
			return i
		}
	}
	return -1
}

func indexStep(steps []ExecutionStep, id string) int {
	for i, step := range steps {
		if step.ID == id {
			return i
		}
	}
	return -1
}

func hasActiveClaim(jobs []ExecutionJob, stepID string, ignore int) bool {
	for i, job := range jobs {
		if i == ignore || job.ExecutionStepID != stepID {
			continue
		}
		if job.Status == JobClaimed || job.Status == JobRunning {
			return true
		}
	}
	return false
}
