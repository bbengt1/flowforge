package wfstore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
	"github.com/bbengt1/flowforge/apps/api/internal/ssh"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const (
	approvalRetryBase   = 30 * time.Second
	approvalRetryJitter = 5 * time.Second
)

// approvalRetryWait is the flat wait before a transient approval rebuild
// may be claimed again. jitter is in [0, 1] and maps onto 30s plus 0 to 5s.
// The outer limit is the pending approval's expires_at, or the gate-ready
// time plus the parked-approval wait duration when no approval is pending.
// This delay does not change attempt.
func approvalRetryWait(jitter float64) time.Duration {
	if jitter < 0 {
		jitter = 0
	}
	if jitter > 1 {
		jitter = 1
	}
	return approvalRetryBase + time.Duration(float64(approvalRetryJitter)*jitter)
}

// ApprovalRetryLimit is the transient-retry deadline for one gate.
// approvalExpiresAt is the pending approval's expires_at. When it is set,
// it is the limit, including when readyAt is zero. With no pending
// approval, the limit is readyAt plus workflow.ApprovalWaitDuration:
// the step expiresIn, or PT1H when that field is missing or not a duration,
// and never longer than the existing P7D ceiling. readyAt is the gate-ready
// time: the latest finished_at among satisfied upstream steps, or the run
// insert time for a root gate (executions.started_at, which Postgres stamps
// at insert and does not move). Those columns are not rewritten by release,
// lease recovery, or reclaim. A zero readyAt with no approval expiry has
// no anchor. This is not the park deadline. A parked approval expires at
// claim time plus the same wait duration.
func ApprovalRetryLimit(readyAt, approvalExpiresAt time.Time, input map[string]any) (time.Time, bool) {
	if !approvalExpiresAt.IsZero() {
		return approvalExpiresAt.UTC(), true
	}
	if readyAt.IsZero() {
		return time.Time{}, false
	}
	raw, _ := input["expiresIn"].(string)
	d, _ := workflow.ApprovalWaitDuration(raw)
	return readyAt.UTC().Add(d), true
}

// ApprovalPastLimit reports that now is at or after ApprovalRetryLimit.
func ApprovalPastLimit(readyAt, approvalExpiresAt time.Time, input map[string]any, now time.Time) bool {
	limit, ok := ApprovalRetryLimit(readyAt, approvalExpiresAt, input)
	if !ok {
		return false
	}
	return !now.Before(limit)
}

func approvalJitter() float64 {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return 0
	}
	return float64(binary.BigEndian.Uint64(buf[:])) / float64(^uint64(0))
}

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
	case JobQueued, JobClaimed, JobRunning, JobWaiting, JobBlocked:
		return true
	default:
		return false
	}
}

func executionIsActive(status string) bool {
	switch status {
	case ExecutionQueued, ExecutionRunning, ExecutionWaiting:
		return true
	default:
		return false
	}
}

func waitOutput(port string, extra map[string]any) map[string]any {
	out := map[string]any{"port": port, "decision": port}
	for k, v := range extra {
		if k == "port" || k == "decision" {
			continue
		}
		out[k] = v
	}
	return out
}

func jobIsWritable(status string) bool {
	return status == JobClaimed || status == JobRunning
}

func rollupExecutionStatus(jobs []ExecutionJob, steps []ExecutionStep) string {
	jobs = latestAttemptJobs(jobs, steps)
	if len(jobs) == 0 {
		return ExecutionQueued
	}
	var sawIndet, sawFailed, sawCanceled, sawClaimed, sawQueued, sawWaiting, sawSuccess, sawSkipped, sawBlocked bool
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
		case JobWaiting:
			sawWaiting = true
		case JobQueued:
			sawQueued = true
		case JobSucceeded:
			sawSuccess = true
		case JobSkipped:
			sawSkipped = true
		case JobBlocked:
			sawBlocked = true
		}
	}
	if sawIndet {
		return ExecutionIndeterminate
	}
	if sawClaimed {
		return ExecutionRunning
	}
	// A parked gate stays waiting while downstream jobs are still blocked.
	if sawWaiting && !sawQueued {
		return ExecutionWaiting
	}
	if sawQueued {
		// Blocked downstream jobs do not promote a fresh start to running.
		if sawSuccess || sawFailed || sawCanceled || sawSkipped {
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
	if sawBlocked {
		return ExecutionRunning
	}
	if sawSuccess || sawSkipped {
		return ExecutionSucceeded
	}
	return ExecutionQueued
}

func applyExecutionStatus(exec *Execution, status string, now time.Time) {
	exec.Status = status
	exec.UpdatedAt = now
	if (status == ExecutionRunning || status == ExecutionWaiting) && exec.StartedAt == nil {
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
	if stepIsFinished(status) {
		finished := now
		step.FinishedAt = &finished
		return
	}
	if status == ExecutionQueued || status == ExecutionRunning || status == ExecutionWaiting || status == ExecutionPending {
		step.FinishedAt = nil
	}
}

func stepIsFinished(status string) bool {
	if status == ExecutionSkipped {
		return true
	}
	return isTerminalExecution(status) && status != ExecutionPinned
}

func buildBinding(scope isolation.Scope, exec Execution, step ExecutionStep, job ExecutionJob, expiresAt, leaseExpires time.Time) JobBinding {
	return JobBinding{
		WorkspaceID:       scope.WorkspaceID(),
		TenantID:          scope.TenantID(),
		WorkbenchKey:      scope.WorkbenchKey(),
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
	if got.TenantID != "" && !authz.ValidUUID(got.TenantID) {
		return ErrJobBinding
	}
	if got.WorkbenchKey != "" && !authz.ValidWorkbenchKey(got.WorkbenchKey) {
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
