package wfstore

import "errors"

// latestAttemptJobs keeps the job of the latest attempt of each node.
// An empty step list keeps every job so callers that have not loaded
// steps still roll a single-attempt run up.
func latestAttemptJobs(jobs []ExecutionJob, steps []ExecutionStep) []ExecutionJob {
	if len(steps) == 0 {
		return jobs
	}
	allow := map[string]struct{}{}
	bestAttempt := map[string]int{}
	bestID := map[string]string{}
	for _, step := range steps {
		attempt, ok := bestAttempt[step.NodeID]
		if ok && step.Attempt < attempt {
			continue
		}
		bestAttempt[step.NodeID] = step.Attempt
		bestID[step.NodeID] = step.ID
	}
	for _, id := range bestID {
		allow[id] = struct{}{}
	}
	kept := make([]ExecutionJob, 0, len(jobs))
	for _, job := range jobs {
		if _, ok := allow[job.ExecutionStepID]; ok {
			kept = append(kept, job)
		}
	}
	return kept
}

func isLatestAttempt(steps []ExecutionStep, step ExecutionStep) bool {
	for _, other := range steps {
		if other.NodeID == step.NodeID && other.Attempt > step.Attempt {
			return false
		}
	}
	return true
}

// retryStatusError is the run and step half of retry eligibility.
// A superseded attempt is reported before the run status so an old
// attempt on a canceled run stays step_attempt_superseded.
func retryStatusError(exec Execution, step ExecutionStep, steps []ExecutionStep) error {
	if !isLatestAttempt(steps, step) {
		return ErrStepAttemptSuperseded
	}
	switch exec.Status {
	case ExecutionCanceled:
		return &NotRetryableError{Reason: ReasonRunCanceled}
	case ExecutionFailed, ExecutionIndeterminate:
	default:
		return &NotRetryableError{Reason: ReasonRunNotFailed}
	}
	if step.StartedAt == nil {
		return &NotRetryableError{Reason: ReasonStepNotStarted}
	}
	if step.Status != ExecutionFailed && step.Status != ExecutionIndeterminate {
		return &NotRetryableError{Reason: ReasonStepNotFailed}
	}
	if step.Status == ExecutionIndeterminate && !allowsIndeterminateRetry(step.NodeType) {
		return ErrRetryNotAllowed
	}
	return nil
}

// incomingReady reports whether every incoming edge is resolved and the
// join is satisfied. The returned count is the unresolved incoming count
// to store on a new attempt (0 when the step may start).
func incomingReady(nodeID string, edges []execEdge) (ready bool, unresolved int) {
	incoming := 0
	satisfied := 0
	requiredUnsatisfied := false
	for _, edge := range edges {
		if edge.ToNode != nodeID {
			continue
		}
		incoming++
		if !edge.Resolved {
			unresolved++
			continue
		}
		if edge.Satisfied {
			satisfied++
			continue
		}
		if edge.Required {
			requiredUnsatisfied = true
		}
	}
	if incoming == 0 {
		return true, 0
	}
	if unresolved > 0 || requiredUnsatisfied || satisfied == 0 {
		return false, unresolved
	}
	return true, 0
}

func incomingRetryError(nodeID string, edges []execEdge) (int, error) {
	ready, unresolved := incomingReady(nodeID, edges)
	if !ready {
		return unresolved, &NotRetryableError{Reason: ReasonIncomingUnresolved}
	}
	return unresolved, nil
}

// classifyRetry is the shared eligibility function for RetryStep and
// capabilities.retry. It does not apply a request-time pin hint.
// A soft-deleted workflow is execution_not_retryable / workflow_deleted
// before attempt, run, or step checks so the capability matches retry.
func classifyRetry(exec Execution, step ExecutionStep, steps []ExecutionStep, edges []execEdge, workflowDeleted bool) error {
	if workflowDeleted {
		return &NotRetryableError{Reason: ReasonWorkflowDeleted}
	}
	if err := retryStatusError(exec, step, steps); err != nil {
		return err
	}
	if err := canRetryStep(step); err != nil {
		return err
	}
	_, err := incomingRetryError(step.NodeID, edges)
	return err
}

func retryCapability(err error) RetryCapability {
	if err == nil {
		return RetryCapability{Allowed: true}
	}
	var refused *NotRetryableError
	if errors.As(err, &refused) {
		return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: refused.Reason}
	}
	if errors.Is(err, ErrStepAttemptSuperseded) {
		return RetryCapability{Allowed: false, Code: CodeStepAttemptSuperseded}
	}
	if errors.Is(err, ErrRetryDenied) || errors.Is(err, ErrRetryNotAllowed) {
		return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: ReasonRetryNotAllowed}
	}
	return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: ReasonRunNotFailed}
}

func applyRetryCapabilities(exec *Execution, steps []ExecutionStep, edges []execEdge, workflowDeleted bool) {
	if exec == nil {
		return
	}
	for i := range steps {
		err := classifyRetry(*exec, steps[i], steps, edges, workflowDeleted)
		cap := ExecutionCapabilities{Retry: retryCapability(err)}
		steps[i].Capabilities = &cap
	}
	execCap := executionRetryCapability(*exec, steps, workflowDeleted)
	exec.Capabilities = &ExecutionCapabilities{Retry: execCap}
}

func executionRetryCapability(exec Execution, steps []ExecutionStep, workflowDeleted bool) RetryCapability {
	if workflowDeleted {
		return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: ReasonWorkflowDeleted}
	}
	switch exec.Status {
	case ExecutionCanceled:
		return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: ReasonRunCanceled}
	case ExecutionFailed, ExecutionIndeterminate:
	default:
		return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: ReasonRunNotFailed}
	}
	var chosen RetryCapability
	chosenSet := false
	for _, step := range steps {
		if step.Capabilities == nil {
			continue
		}
		cap := step.Capabilities.Retry
		if cap.Allowed {
			return RetryCapability{Allowed: true}
		}
		if !chosenSet || (chosen.Code == CodeStepAttemptSuperseded && cap.Code != CodeStepAttemptSuperseded) {
			chosen = cap
			chosenSet = true
		}
	}
	if chosenSet {
		return chosen
	}
	return RetryCapability{Allowed: false, Code: CodeExecutionNotRetryable, Reason: ReasonStepNotFailed}
}

// guardCanceledRollup leaves a canceled run canceled. Callers pass the
// status loaded before the roll-up so a retry cannot reopen it.
func guardCanceledRollup(current, next string) string {
	if current == ExecutionCanceled {
		return ExecutionCanceled
	}
	return next
}
