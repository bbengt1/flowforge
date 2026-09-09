package wfstore

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/ssh"
)

func normalizeLease(d time.Duration) time.Duration {
	if d <= 0 {
		return DefaultLease
	}
	if d < MinLease {
		return MinLease
	}
	if d > MaxLease {
		return MaxLease
	}
	return d
}

func normalizeBindingTTL(d time.Duration) time.Duration {
	if d <= 0 {
		return DefaultJobBindingTTL
	}
	if d < MinLease {
		return MinLease
	}
	if d > 24*time.Hour {
		return 24 * time.Hour
	}
	return d
}

func normalizeWorkerID(id string) (string, error) {
	id = strings.TrimSpace(id)
	if id == "" || len(id) > 200 {
		return "", ErrInvalid
	}
	return id, nil
}

func snapshotDigest(v map[string]any) string {
	if v == nil {
		v = map[string]any{}
	}
	raw, err := json.Marshal(v)
	if err != nil {
		sum := sha256.Sum256(nil)
		return "sha256:" + hex.EncodeToString(sum[:])
	}
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func retryPolicy(nodeType string) (safe bool, maxRetries int) {
	nodeType = strings.TrimSpace(nodeType)
	if strings.HasPrefix(nodeType, "data.") || strings.HasPrefix(nodeType, "flow.") {
		return true, DefaultRetrySafeMax
	}
	if nodeType == ssh.NodeSSHRun {
		return false, ssh.DefaultMaxAttempts
	}
	if scripts.IsScriptNode(nodeType) {
		return false, scripts.DefaultMaxAttempts
	}
	return false, 0
}

func allowsIndeterminateRetry(nodeType string) bool {
	return nodeType == ssh.NodeSSHRun || scripts.IsScriptNode(nodeType)
}

func canRetryStep(step ExecutionStep) error {
	if step.NodeType == ssh.NodeSSHRun {
		return canRetrySSHStep(step)
	}
	if scripts.IsScriptNode(step.NodeType) {
		return canRetryScriptStep(step)
	}
	switch step.Status {
	case ExecutionFailed, ExecutionCanceled:
	default:
		return ErrRetryNotAllowed
	}
	safe, maxRetries := retryPolicy(step.NodeType)
	if !safe {
		return ErrRetryNotAllowed
	}
	if step.Attempt >= 1+maxRetries {
		return ErrRetryNotAllowed
	}
	return nil
}

func canRetrySSHStep(step ExecutionStep) error {
	switch step.Status {
	case ExecutionFailed, ExecutionCanceled, ExecutionIndeterminate:
	default:
		return ErrRetryNotAllowed
	}
	eval := sshRetryEval(step)
	dec := ssh.EvaluateRetry(eval)
	if dec.Allowed {
		return nil
	}
	if dec.Code == ssh.CodeRetryDenied {
		return ErrRetryDenied
	}
	return ErrRetryNotAllowed
}

func canRetryScriptStep(step ExecutionStep) error {
	switch step.Status {
	case ExecutionFailed, ExecutionCanceled, ExecutionIndeterminate:
	default:
		return ErrRetryNotAllowed
	}
	eval := scriptRetryEval(step)
	dec := scripts.EvaluateRetry(eval)
	if dec.Allowed {
		return nil
	}
	if dec.Code == scripts.CodeRetryDenied {
		return ErrRetryDenied
	}
	return ErrRetryNotAllowed
}

func scriptRetryEval(step ExecutionStep) scripts.RetryEval {
	max := scripts.MaxAttemptsFromWith(step.Input)
	safe, hasVerify, hasKey := scriptRetryFlags(step)
	if n, ok := asIntAny(step.PolicySnapshot["maxAttempts"]); ok {
		max = n
	}
	return scripts.RetryEval{
		Status:             step.Status,
		Attempt:            step.Attempt,
		MaxAttempts:        max,
		RetrySafe:          safe,
		HasVerification:    hasVerify,
		HasIdempotencyKey:  hasKey,
		PriorIndeterminate: step.Status == ExecutionIndeterminate,
	}
}

func scriptRetryFlags(step ExecutionStep) (retrySafe, hasVerification, hasKey bool) {
	retrySafe = boolFrom(step.PolicySnapshot, "retrySafe")
	hasVerification = boolFrom(step.PolicySnapshot, "verificationDeclared") || mapFrom(step.PolicySnapshot, "verification") != nil
	hasKey = boolFrom(step.PolicySnapshot, "idempotencyKeyDeclared") || stringFrom(step.PolicySnapshot, "idempotencyKey") != ""
	if retry, ok := step.Output["retry"].(map[string]any); ok {
		if v, exists := retry["retrySafe"]; exists {
			retrySafe, _ = v.(bool)
		}
		if v, exists := retry["verificationDeclared"]; exists {
			hasVerification, _ = v.(bool)
		}
		if v, exists := retry["idempotencyKey"]; exists {
			s, _ := v.(string)
			hasKey = hasKey || strings.TrimSpace(s) != ""
		}
	}
	if retry, ok := step.Error["retry"].(map[string]any); ok {
		if v, exists := retry["retrySafe"]; exists {
			retrySafe, _ = v.(bool)
		}
		if v, exists := retry["verificationDeclared"]; exists {
			hasVerification, _ = v.(bool)
		}
		if v, exists := retry["idempotencyKey"]; exists {
			s, _ := v.(string)
			hasKey = hasKey || strings.TrimSpace(s) != ""
		}
	}
	if strings.TrimSpace(stringFrom(step.Input, "idempotencyKey")) != "" {
		hasKey = true
	}
	return retrySafe, hasVerification, hasKey
}

func stringFrom(m map[string]any, key string) string {
	if m == nil {
		return ""
	}
	s, _ := m[key].(string)
	return strings.TrimSpace(s)
}

func asIntAny(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		if n == float64(int(n)) {
			return int(n), true
		}
	}
	return 0, false
}

func sshRetryEval(step ExecutionStep) ssh.RetryEval {
	max := ssh.MaxAttemptsFromWith(step.Input)
	safe, hasVerify := sshRetryFlags(step)
	return ssh.RetryEval{
		Status:             step.Status,
		Attempt:            step.Attempt,
		MaxAttempts:        max,
		RetrySafe:          safe,
		HasVerification:    hasVerify,
		PriorIndeterminate: step.Status == ExecutionIndeterminate,
	}
}

func sshRetryFlags(step ExecutionStep) (retrySafe bool, hasVerification bool) {
	retrySafe, hasVerification = boolFrom(step.PolicySnapshot, "retrySafe"), boolFrom(step.PolicySnapshot, "verificationDeclared") || mapFrom(step.PolicySnapshot, "verification") != nil
	if retry, ok := step.Output["retry"].(map[string]any); ok {
		if v, exists := retry["retrySafe"]; exists {
			retrySafe, _ = v.(bool)
		}
		if v, exists := retry["verificationDeclared"]; exists {
			hasVerification, _ = v.(bool)
		}
		if v, exists := retry["requiresVerification"]; exists && !hasVerification {
			hasVerification, _ = v.(bool)
		}
	}
	if retry, ok := step.Error["retry"].(map[string]any); ok {
		if v, exists := retry["retrySafe"]; exists {
			retrySafe, _ = v.(bool)
		}
		if v, exists := retry["verificationDeclared"]; exists {
			hasVerification, _ = v.(bool)
		}
	}
	return retrySafe, hasVerification
}

func applyRetryHint(step *ExecutionStep, hint map[string]any) {
	if step == nil || hint == nil {
		return
	}
	if step.PolicySnapshot == nil {
		step.PolicySnapshot = map[string]any{}
	}
	for k, v := range hint {
		step.PolicySnapshot[k] = v
	}
}

func boolFrom(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	b, _ := m[key].(bool)
	return b
}

func mapFrom(m map[string]any, key string) map[string]any {
	if m == nil {
		return nil
	}
	v, _ := m[key].(map[string]any)
	return v
}

func emergencyStopJobStatus(job ExecutionJob, uncertain bool) string {
	if uncertain || job.Status == JobRunning || job.HeartbeatAt != nil {
		return JobIndeterminate
	}
	return JobCanceled
}

func emergencyStopStepStatus(jobStatus string) string {
	if jobStatus == JobIndeterminate {
		return ExecutionIndeterminate
	}
	return ExecutionCanceled
}

func jobIsOpen(status string) bool {
	switch status {
	case JobQueued, JobClaimed, JobRunning:
		return true
	default:
		return false
	}
}

func jobIsWritable(status string) bool {
	return status == JobClaimed || status == JobRunning
}

func rollupExecutionStatus(jobs []ExecutionJob) string {
	if len(jobs) == 0 {
		return ExecutionQueued
	}
	var sawIndet, sawFailed, sawCanceled, sawClaimed, sawQueued, sawSuccess bool
	for _, job := range jobs {
		switch job.Status {
		case JobIndeterminate:
			sawIndet = true
		case JobFailed:
			sawFailed = true
		case JobCanceled:
			sawCanceled = true
		case JobClaimed, JobRunning:
			sawClaimed = true
		case JobQueued:
			sawQueued = true
		case JobSucceeded:
			sawSuccess = true
		}
	}
	if sawIndet {
		return ExecutionIndeterminate
	}
	if sawClaimed {
		return ExecutionRunning
	}
	if sawQueued {
		if sawSuccess || sawFailed || sawCanceled {
			return ExecutionRunning
		}
		return ExecutionQueued
	}
	if sawFailed {
		return ExecutionFailed
	}
	if sawCanceled {
		return ExecutionCanceled
	}
	if sawSuccess {
		return ExecutionSucceeded
	}
	return ExecutionQueued
}

func applyExecutionStatus(exec *Execution, status string, now time.Time) {
	exec.Status = status
	exec.UpdatedAt = now
	if status == ExecutionRunning && exec.StartedAt == nil {
		started := now
		exec.StartedAt = &started
	}
	if isTerminalExecution(status) && status != ExecutionPinned {
		finished := now
		exec.FinishedAt = &finished
		return
	}
	if !isTerminalExecution(status) {
		exec.FinishedAt = nil
	}
}

func applyStepStatus(step *ExecutionStep, status string, now time.Time) {
	step.Status = status
	step.UpdatedAt = now
	if status == ExecutionRunning && step.StartedAt == nil {
		started := now
		step.StartedAt = &started
	}
	if isTerminalExecution(status) && status != ExecutionPinned {
		finished := now
		step.FinishedAt = &finished
		return
	}
	if status == ExecutionQueued || status == ExecutionRunning {
		step.FinishedAt = nil
	}
}

func buildBinding(scopeWorkspace string, exec Execution, step ExecutionStep, job ExecutionJob, expiresAt, leaseExpires time.Time) JobBinding {
	return JobBinding{
		WorkspaceID:       scopeWorkspace,
		ExecutionID:       exec.ID,
		JobID:             job.ID,
		StepID:            step.ID,
		WorkflowID:        exec.WorkflowID,
		WorkflowVersionID: exec.WorkflowVersionID,
		WorkflowDigest:    exec.WorkflowDigest,
		PolicyDigest:      snapshotDigest(exec.PolicySnapshot),
		CorrelationID:     exec.CorrelationID,
		FencingToken:      job.FencingToken,
		ExpiresAt:         expiresAt.UTC(),
		LeaseExpiresAt:    leaseExpires.UTC(),
	}
}

// AuthorizeJobBinding is the worker-side fail-closed check: reject altered,
// expired, or cross-workspace jobs before a provider call.
func AuthorizeJobBinding(got JobBinding, workspaceID, versionID, digest string, now time.Time) error {
	if !authz.ValidUUID(got.WorkspaceID) || !authz.ValidUUID(got.JobID) || !authz.ValidUUID(got.ExecutionID) {
		return ErrJobBinding
	}
	if workspaceID != "" && got.WorkspaceID != workspaceID {
		return ErrJobBinding
	}
	if versionID != "" && got.WorkflowVersionID != versionID {
		return ErrJobBinding
	}
	if digest != "" && got.WorkflowDigest != digest {
		return ErrJobBinding
	}
	if strings.TrimSpace(got.WorkflowVersionID) == "" || strings.TrimSpace(got.WorkflowDigest) == "" {
		return ErrJobBinding
	}
	if !strings.HasPrefix(got.WorkflowDigest, "sha256:") {
		return ErrJobBinding
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if !now.Before(got.ExpiresAt) {
		return ErrJobExpired
	}
	return nil
}

func matchFence(job ExecutionJob, in JobActionInput) error {
	if in.FencingToken != job.FencingToken || in.FencingToken < 1 {
		return ErrFenceConflict
	}
	if in.WorkerID != "" && job.WorkerID != "" && in.WorkerID != job.WorkerID {
		return ErrFenceConflict
	}
	return nil
}

func requireActiveLease(job ExecutionJob, now time.Time) error {
	if !jobIsWritable(job.Status) {
		if job.Status == JobCanceled {
			return ErrCanceled
		}
		return ErrNotClaimable
	}
	if job.LeaseExpiresAt != nil && !now.Before(*job.LeaseExpiresAt) {
		return ErrLeaseExpired
	}
	return nil
}

func cloneJob(job ExecutionJob) ExecutionJob {
	out := job
	if job.LeaseExpiresAt != nil {
		ts := *job.LeaseExpiresAt
		out.LeaseExpiresAt = &ts
	}
	if job.HeartbeatAt != nil {
		ts := *job.HeartbeatAt
		out.HeartbeatAt = &ts
	}
	return out
}

func cloneStep(step ExecutionStep) ExecutionStep {
	out := step
	out.PolicySnapshot = cloneObject(step.PolicySnapshot)
	out.TargetSnapshot = cloneObject(step.TargetSnapshot)
	out.Input = cloneObject(step.Input)
	out.Output = cloneObject(step.Output)
	out.Error = cloneObject(step.Error)
	if step.StartedAt != nil {
		ts := *step.StartedAt
		out.StartedAt = &ts
	}
	if step.FinishedAt != nil {
		ts := *step.FinishedAt
		out.FinishedAt = &ts
	}
	return out
}
