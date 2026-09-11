package wfstore

import (
	"context"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
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

func (m *Memory) ClaimJob(_ context.Context, scope isolation.Scope, now time.Time, in ClaimInput) (DispatchResult, error) {
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
	defer m.mu.Unlock()
	recovered := m.recoverExpiredLocked(scope, now)

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
			if job.Status != JobQueued || job.AvailableAt.After(now) {
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
		if recovered > 0 {
			return DispatchResult{Recovered: recovered}, ErrEmptyClaim
		}
		return DispatchResult{}, ErrEmptyClaim
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

func (m *Memory) ReleaseJob(_ context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error) {
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
		job.Status = JobQueued
		job.WorkerID = ""
		job.LeaseExpiresAt = nil
		job.HeartbeatAt = nil
		job.UpdatedAt = now
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

func (m *Memory) CancelExecution(_ context.Context, scope isolation.Scope, now time.Time, executionID string) (Execution, error) {
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
	for i := range exec.jobs {
		if jobIsOpen(exec.jobs[i].Status) {
			exec.jobs[i].Status = JobCanceled
			exec.jobs[i].UpdatedAt = now
		}
	}
	for i := range exec.steps {
		if exec.steps[i].Status == ExecutionQueued || exec.steps[i].Status == ExecutionRunning || exec.steps[i].Status == ExecutionWaiting {
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

func (m *Memory) RetryStep(_ context.Context, scope isolation.Scope, now time.Time, executionID, stepID string, hint ...map[string]any) (RetryResult, error) {
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
	if exec.record.Status == ExecutionIndeterminate && (len(hint) == 0 || hint[0] == nil) {
		// SSH retry-safe + verification may still queue a verify-first attempt.
	}
	stepIdx := indexStep(exec.steps, stepID)
	if stepIdx < 0 {
		return RetryResult{}, ErrNotFound
	}
	src := exec.steps[stepIdx]
	if exec.record.Status == ExecutionIndeterminate && !allowsIndeterminateRetry(src.NodeType) {
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

func (m *Memory) RecoverExpiredLeases(_ context.Context, scope isolation.Scope, now time.Time) (int, error) {
	if scope.Zero() {
		return 0, ErrNoScope
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.recoverExpiredLocked(scope, now), nil
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

func (m *Memory) ResumeWait(_ context.Context, scope isolation.Scope, now time.Time, in ResumeWaitInput) (DispatchResult, error) {
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

func (m *Memory) recoverExpiredLocked(scope isolation.Scope, now time.Time) int {
	n := 0
	for id, exec := range m.executions {
		if exec.workspaceID != scope.WorkspaceID() {
			continue
		}
		changed := false
		outcome := "indeterminate"
		for i, job := range exec.jobs {
			stepIdx := indexStep(exec.steps, job.ExecutionStepID)
			if job.Status == JobWaiting && !job.AvailableAt.After(now) {
				job.Status = JobSucceeded
				job.UpdatedAt = now
				exec.jobs[i] = job
				if stepIdx >= 0 {
					exec.steps[stepIdx].Output = waitOutput("expired", nil)
					applyStepStatus(&exec.steps[stepIdx], ExecutionSucceeded, now)
				}
				changed = true
				outcome = "expired"
				n++
				continue
			}
			if !jobIsWritable(job.Status) || job.LeaseExpiresAt == nil || now.Before(*job.LeaseExpiresAt) {
				continue
			}
			if stepIdx >= 0 && exec.steps[stepIdx].NodeType == "flow.approval" {
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
	return n
}

func (m *Memory) rollupLocked(exec *memExecution, now time.Time) {
	applyExecutionStatus(&exec.record, rollupExecutionStatus(exec.jobs), now)
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
