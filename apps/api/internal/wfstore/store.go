// Package wfstore persists workspace-scoped workflow drafts, immutable
// published versions, and durable executions, steps, jobs, and audit events.
package wfstore

import (
	"context"
	"errors"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Persistence errors.
var (
	ErrNotFound              = errors.New("not found")
	ErrConflict              = errors.New("conflict")
	ErrRevisionConflict      = errors.New("draft revision conflict")
	ErrInvalid               = errors.New("invalid")
	ErrNoScope               = errors.New("workspace scope is not set")
	ErrImmutable             = errors.New("published versions are immutable")
	ErrDraftNotRunnable      = errors.New("drafts cannot be executed")
	ErrDuplicateVersion      = errors.New("definition already published")
	ErrStoreUnavailable      = errors.New("workflow store is unavailable")
	ErrIdempotencyConflict   = errors.New("idempotency key reused with a different fingerprint")
	ErrIdempotencyKeyInvalid = errors.New("idempotency key is invalid")
	ErrEmptyClaim            = errors.New("no eligible job")
	ErrFenceConflict         = errors.New("fencing token mismatch")
	ErrLeaseExpired          = errors.New("lease expired")
	ErrJobBinding            = errors.New("job binding rejected")
	ErrJobExpired            = errors.New("authenticated job expired")
	// ErrJobBindingSecret is a boot-fail: JOB_BINDING_SECRET is missing
	// or not a 32-byte HMAC key. Loaders never invent a process key.
	ErrJobBindingSecret = errors.New("JOB_BINDING_SECRET is missing or malformed")
	ErrNotClaimable     = errors.New("job is not in a claimable or writable state")
	ErrAlreadyTerminal  = errors.New("execution is already terminal")
	ErrRetryNotAllowed  = errors.New("retry is not allowed")
	ErrRetryDenied      = errors.New("retry-denied")
	ErrCanceled         = errors.New("execution or job was canceled")
	// ErrExecutionNotRetryable refuses a retry that is not on the latest
	// failed or indeterminate attempt of a failed or indeterminate run.
	ErrExecutionNotRetryable = errors.New("execution is not retryable")
	// ErrStepAttemptSuperseded refuses a retry of an attempt that is no
	// longer the latest for its node.
	ErrStepAttemptSuperseded = errors.New("step attempt was superseded")
	// ErrConstraint is a unique violation that is not a workflow slug,
	// an execution idempotency key, or a folder sibling name.
	ErrConstraint                 = errors.New("constraint")
	ErrEmergencyStopNotApplicable = errors.New("emergency stop applies only to an open script execution")
	ErrUnsafeArtifact             = errors.New("artifact content cannot be safely retained")
	ErrArtifactExpired            = errors.New("artifact has expired")
	ErrLegalHold                  = errors.New("artifact is under legal hold")
	ErrGrantExpired               = errors.New("download grant has expired")
	ErrFolderName                 = errors.New("invalid folder name")
	ErrFolderDepth                = errors.New("folder depth exceeds maximum")
	ErrFolderCycle                = errors.New("folder re-parent would create a cycle")
	ErrFolderNotEmpty             = errors.New("folder is not empty")
	// ErrConcurrency is the per-workspace cap on non-terminal executions.
	ErrConcurrency = errors.New("execution concurrency limit exceeded")
	// ErrActiveExecutions blocks soft-delete while any non-terminal run
	// of the workflow has a job in queued, claimed, or running. Waiting,
	// pending, and blocked work does not block. Pinned rows do not block.
	ErrActiveExecutions = errors.New("workflow has active executions")
	// ErrSlugReserved is a tombstone holding the slug. A live slug is ErrConflict.
	ErrSlugReserved = errors.New("workflow slug is reserved")
	// ErrWorkflowDeleted means a resume, requeue, or claim found deleted_at
	// set. The run is failed with ReasonWorkflowDeleted and must not
	// continue. Step retry reports that tombstone as
	// execution_not_retryable with reason workflow_deleted.
	ErrWorkflowDeleted = errors.New("workflow was deleted")
)

// Validation states persisted with a draft.
const (
	ValidationValid   = "valid"
	ValidationInvalid = "invalid"
)

// Workflow statuses.
const (
	StatusDraft     = "draft"
	StatusPublished = "published"
	StatusArchived  = "archived"
)

// Execution and step statuses. pinned is retained for E3.2 stub rows.
const (
	ExecutionQueued        = "queued"
	ExecutionPinned        = "pinned"
	ExecutionRunning       = "running"
	ExecutionWaiting       = "waiting"
	ExecutionSucceeded     = "succeeded"
	ExecutionFailed        = "failed"
	ExecutionCanceled      = "canceled"
	ExecutionIndeterminate = "indeterminate"
	ExecutionPending       = "pending"
	ExecutionSkipped       = "skipped"

	// ReasonWorkflowDeleted is the matchable end reason on a run that was
	// waiting or about to resume when its workflow was soft-deleted.
	// It is stored on the step error and on execution detail statusReason.
	ReasonWorkflowDeleted = "workflow_deleted"

	// ReasonRequirementUnresolvable is the matchable end reason when a
	// pending approval cannot be rebuilt from its pinned version. The gate
	// step stores this code. Execution detail statusReason repeats it.
	// It is a broken setup, not a wait that timed out.
	ReasonRequirementUnresolvable = "requirement_unresolvable"

	// Retry refusal codes and reasons. The same values are written on
	// capabilities.retry and on the retry 409. SSH and script policy
	// denial is execution_not_retryable with reason retry_not_allowed.
	// A soft-deleted workflow uses reason workflow_deleted.
	CodeExecutionNotRetryable = "execution_not_retryable"
	CodeStepAttemptSuperseded = "step_attempt_superseded"
	ReasonRunCanceled         = "run_canceled"
	ReasonRunNotFailed        = "run_not_failed"
	ReasonStepNotStarted      = "step_not_started"
	ReasonStepNotFailed       = "step_not_failed"
	ReasonIncomingUnresolved  = "incoming_unresolved"
	ReasonRetryNotAllowed     = "retry_not_allowed"
)

// Job statuses. claimed/running are reserved for E5.2 leases.
const (
	JobQueued        = "queued"
	JobClaimed       = "claimed"
	JobRunning       = "running"
	JobWaiting       = "waiting"
	JobSucceeded     = "succeeded"
	JobFailed        = "failed"
	JobCanceled      = "canceled"
	JobIndeterminate = "indeterminate"
	JobBlocked       = "blocked"
	JobSkipped       = "skipped"
)

const (
	DefaultExecutionRetention = 90 * 24 * time.Hour
	DefaultAuditRetention     = 365 * 24 * time.Hour
	MaxIdempotencyKeyLen      = 128
	MaxExecutionInputBytes    = 16 * 1024
	DefaultListLimit          = 50
	MaxListLimit              = 100
	DefaultLease              = 30 * time.Second
	MinLease                  = time.Second
	MaxLease                  = 5 * time.Minute
	DefaultJobBindingTTL      = time.Hour
	DefaultRetrySafeMax       = 3
	DefaultDownloadTTL        = 60 * time.Second
	MaxDownloadTTL            = 5 * time.Minute
	MaxStepOutputBytes        = 16 * 1024
	MaxFolderDepth            = 4
	MaxFolderNameGraphemes    = 64
	FolderListUnfiled         = "unfiled"
)

// DeleteResult is the secret-free record of a soft delete.
type DeleteResult struct {
	ID         string
	Name       string
	Published  bool
	ClosedRuns []string
}

// Workflow is the workspace-owned authoring record.
type Workflow struct {
	ID                  string    `json:"id"`
	Slug                string    `json:"slug"`
	Name                string    `json:"name"`
	Status              string    `json:"status"`
	DraftRevision       int64     `json:"draftRevision"`
	DraftDigest         string    `json:"draftDigest"`
	LatestVersionNumber int       `json:"latestVersionNumber"`
	LatestVersionID     string    `json:"latestVersionId,omitempty"`
	LatestVersionDigest string    `json:"latestVersionDigest,omitempty"`
	CreatedBy           string    `json:"createdBy,omitempty"`
	UpdatedBy           string    `json:"updatedBy,omitempty"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
	FolderID            *string   `json:"folderId"`
}

// Draft is the single mutable normalized document for a workflow.
type Draft struct {
	WorkflowID      string                `json:"workflowId"`
	Revision        int64                 `json:"revision"`
	DefinitionYAML  string                `json:"definitionYaml"`
	Digest          string                `json:"digest"`
	Summary         workflow.Summary      `json:"summary"`
	Warnings        []workflow.FieldError `json:"warnings"`
	ValidationState string                `json:"validationState"`
	UpdatedBy       string                `json:"updatedBy,omitempty"`
	UpdatedAt       time.Time             `json:"updatedAt"`
}

// Version is an immutable published snapshot.
type Version struct {
	ID             string           `json:"id"`
	WorkflowID     string           `json:"workflowId"`
	VersionNumber  int              `json:"versionNumber"`
	DefinitionYAML string           `json:"definitionYaml"`
	Digest         string           `json:"digest"`
	Summary        workflow.Summary `json:"summary"`
	PublishNote    string           `json:"publishNote"`
	PublishedBy    string           `json:"publishedBy,omitempty"`
	PublishedAt    time.Time        `json:"publishedAt"`
}

// Execution is a durable run pinned to a published version and digest.
type Execution struct {
	ID                string                 `json:"id"`
	WorkflowID        string                 `json:"workflowId"`
	WorkflowSlug      string                 `json:"workflowSlug,omitempty"`
	WorkflowName      string                 `json:"workflowName,omitempty"`
	WorkflowVersionID string                 `json:"workflowVersionId"`
	WorkflowDigest    string                 `json:"workflowDigest"`
	TriggerID         string                 `json:"triggerId,omitempty"`
	Status            string                 `json:"status"`
	IdempotencyKey    string                 `json:"idempotencyKey,omitempty"`
	Input             map[string]any         `json:"input"`
	PolicySnapshot    map[string]any         `json:"policySnapshot"`
	CorrelationID     string                 `json:"correlationId,omitempty"`
	RequestedBy       string                 `json:"requestedBy,omitempty"`
	CreatedAt         time.Time              `json:"createdAt"`
	StartedAt         *time.Time             `json:"startedAt,omitempty"`
	FinishedAt        *time.Time             `json:"finishedAt,omitempty"`
	UpdatedAt         time.Time              `json:"updatedAt"`
	RetentionUntil    time.Time              `json:"retentionUntil"`
	Replayed          bool                   `json:"replayed"`
	Capabilities      *ExecutionCapabilities `json:"capabilities,omitempty"`
	fingerprint       string
}

// ExecutionStep is one node attempt. Outputs are redacted before persist.
type ExecutionStep struct {
	ID              string         `json:"id"`
	ExecutionID     string         `json:"executionId"`
	NodeID          string         `json:"nodeId"`
	NodeType        string         `json:"nodeType"`
	Attempt         int            `json:"attempt"`
	Status          string         `json:"status"`
	LeaseID         string         `json:"leaseId,omitempty"`
	FencingToken    int64          `json:"fencingToken"`
	IdempotencyKey  string         `json:"idempotencyKey,omitempty"`
	PolicySnapshot  map[string]any `json:"policySnapshot"`
	TargetSnapshot  map[string]any `json:"targetSnapshot"`
	Input           map[string]any `json:"input"`
	Output          map[string]any `json:"output"`
	Error           map[string]any `json:"error"`
	OutputTruncated bool           `json:"outputTruncated,omitempty"`
	CreatedAt       time.Time      `json:"createdAt"`
	StartedAt       *time.Time     `json:"startedAt,omitempty"`
	FinishedAt      *time.Time     `json:"finishedAt,omitempty"`
	UpdatedAt       time.Time      `json:"updatedAt"`
	// UnresolvedIncoming is the number of incoming edges that have not
	// resolved yet. It is a claim backstop, not an API field.
	UnresolvedIncoming int                    `json:"-"`
	Capabilities       *ExecutionCapabilities `json:"capabilities,omitempty"`
}

// RetryCapability is the read-only retry eligibility for one run or step.
// Allowed steps omit code and reason. The code and reason match the 409
// RetryStep returns for the same inputs, without the request-time SSH or
// script pin hint.
type RetryCapability struct {
	Allowed bool   `json:"allowed"`
	Code    string `json:"code,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// ExecutionCapabilities is the read-only action set on an execution and
// on each step. Both use the same object.
type ExecutionCapabilities struct {
	Retry RetryCapability `json:"retry"`
}

// NotRetryableError is a 409 execution_not_retryable refusal. Reason is
// the machine-readable cause.
type NotRetryableError struct {
	Reason string
}

func (e *NotRetryableError) Error() string {
	return "This execution cannot be retried."
}

func (e *NotRetryableError) Unwrap() error {
	return ErrExecutionNotRetryable
}

// Artifact is redacted, encrypted-at-rest execution output metadata.
// storage_ref, envelopes, and key material are never serialized to JSON.
type Artifact struct {
	ID                    string     `json:"id"`
	ExecutionID           string     `json:"executionId"`
	ExecutionStepID       string     `json:"executionStepId,omitempty"`
	Kind                  string     `json:"kind"`
	Filename              string     `json:"filename"`
	ContentType           string     `json:"contentType"`
	Digest                string     `json:"digest"`
	SizeBytes             int64      `json:"sizeBytes"`
	ContentClassification string     `json:"contentClassification"`
	Redacted              bool       `json:"redacted"`
	ExpiresAt             time.Time  `json:"expiresAt"`
	LegalHold             bool       `json:"legalHold"`
	LegalHoldReason       string     `json:"legalHoldReason,omitempty"`
	LegalHoldBy           string     `json:"legalHoldBy,omitempty"`
	LegalHoldAt           *time.Time `json:"legalHoldAt,omitempty"`
	CreatedAt             time.Time  `json:"createdAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
	StorageRef            string     `json:"-"`
	DEKEnvelope           []byte     `json:"-"`
	KeyReference          string     `json:"-"`
	EncryptionVersion     int        `json:"-"`
	MetadataCiphertext    []byte     `json:"-"`
}

// DownloadGrant is a short-lived, single-artifact download authorization.
// The href is a same-origin API path — never a bucket URL or credential.
type DownloadGrant struct {
	ID         string    `json:"id"`
	ArtifactID string    `json:"artifactId"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Href       string    `json:"href"`
	Method     string    `json:"method"`
	ActorID    string    `json:"-"`
}

// ArtifactListFilter selects artifacts for one execution.
type ArtifactListFilter struct {
	ExecutionID string
	StepID      string
	Kind        string
}

// CreateArtifactInput records a scanned, encrypted payload.
type CreateArtifactInput struct {
	ExecutionID           string
	StepID                string
	Kind                  string
	Filename              string
	ContentType           string
	ContentClassification string
	Digest                string
	SizeBytes             int64
	Redacted              bool
	ExpiresAt             time.Time
	StorageRef            string
	MetadataCiphertext    []byte
	DEKEnvelope           []byte
	KeyReference          string
	EncryptionVersion     int
}

// LegalHoldInput places or releases an authorized hold.
type LegalHoldInput struct {
	Hold   bool
	Reason string
}

// RetentionPlan is the set of artifacts a purge must process before
// deleting metadata or parent executions.
type RetentionPlan struct {
	Purge []Artifact
	Hold  []Artifact
}

// StepLogs is a bounded window of redacted log lines.
type StepLogs struct {
	Lines     []string `json:"lines"`
	Offset    int      `json:"offset"`
	Next      int      `json:"nextOffset"`
	Truncated bool     `json:"truncated"`
	MaxBytes  int      `json:"maxBytes"`
}

// ExecutionJob is the durable dispatch record for a step attempt.
type ExecutionJob struct {
	ID              string     `json:"id"`
	ExecutionID     string     `json:"executionId"`
	ExecutionStepID string     `json:"executionStepId"`
	Status          string     `json:"status"`
	AvailableAt     time.Time  `json:"availableAt"`
	LeaseExpiresAt  *time.Time `json:"leaseExpiresAt,omitempty"`
	HeartbeatAt     *time.Time `json:"heartbeatAt,omitempty"`
	WorkerID        string     `json:"workerId,omitempty"`
	FencingToken    int64      `json:"fencingToken"`
	Attempt         int        `json:"attempt"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	// TraceParent and TraceState are W3C trace-context captured when the
	// job was queued. They are not part of the browser JSON contract.
	TraceParent string `json:"-"`
	TraceState  string `json:"-"`
}

// AuditEvent is an append-only, secret-free workspace audit row.
type AuditEvent struct {
	ID             string         `json:"id"`
	ActorID        string         `json:"actorId,omitempty"`
	HostContext    map[string]any `json:"hostContext"`
	Action         string         `json:"action"`
	ResourceType   string         `json:"resourceType"`
	ResourceID     string         `json:"resourceId,omitempty"`
	Outcome        string         `json:"outcome"`
	CorrelationID  string         `json:"correlationId,omitempty"`
	Details        map[string]any `json:"details"`
	OccurredAt     time.Time      `json:"occurredAt"`
	RetentionUntil time.Time      `json:"retentionUntil"`
}

// ExecutionListFilter selects workspace-scoped executions.
// Page, when Bound, replaces Limit with keyset pagination.
type ExecutionListFilter struct {
	WorkflowID string
	Status     string
	Limit      int
	Page       page.Query
}

// AuditListFilter selects workspace-scoped audit events.
// Page, when Bound, replaces Limit with keyset pagination.
type AuditListFilter struct {
	ResourceType string
	ResourceID   string
	Action       string
	Limit        int
	Page         page.Query
}

// CompareRef selects a draft or published version for comparison.
type CompareRef struct {
	Kind          string `json:"kind"`
	VersionID     string `json:"versionId,omitempty"`
	VersionNumber int    `json:"versionNumber,omitempty"`
}

// Change is one structured difference between two definitions.
type Change struct {
	Path  string `json:"path"`
	Op    string `json:"op"`
	Left  any    `json:"left,omitempty"`
	Right any    `json:"right,omitempty"`
}

// CompareResult is the draft/version diff returned to the UI.
type CompareResult struct {
	Equal       bool       `json:"equal"`
	DigestMatch bool       `json:"digestMatch"`
	Left        CompareRef `json:"left"`
	Right       CompareRef `json:"right"`
	LeftDigest  string     `json:"leftDigest"`
	RightDigest string     `json:"rightDigest"`
	Changes     []Change   `json:"changes"`
}

// Folder is a workspace-owned organizer node. It is not stored in YAML.
type Folder struct {
	ID          string    `json:"id"`
	WorkspaceID string    `json:"workspaceId"`
	ParentID    *string   `json:"parentId"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

// WorkflowListFilter is an additive list selector. Zero value lists all
// workflows in the workspace (internal callers). Page.Bound is the HTTP
// keyset page: default 50, max 100, optional q on name and slug.
type WorkflowListFilter struct {
	Unfiled  bool
	FolderID string
	Page     page.Query
}

// CreateFolderInput creates a folder under an optional parent.
type CreateFolderInput struct {
	Name     string
	ParentID string
}

// UpdateFolderInput renames and/or re-parents a folder. Nil fields are
// left unchanged. ParentID pointing at "" moves the folder to top-level.
type UpdateFolderInput struct {
	Name     *string
	ParentID *string
}

// FolderNotEmptyError is returned when DELETE is refused because the
// folder still has child folders or workflows. Never cascade-deletes.
type FolderNotEmptyError struct {
	WorkflowCount    int
	ChildFolderCount int
}

func (e FolderNotEmptyError) Error() string { return ErrFolderNotEmpty.Error() }

func (e FolderNotEmptyError) Unwrap() error { return ErrFolderNotEmpty }

// SlugConflict is a create-time slug clash. Reserved means a soft-deleted
// workflow still holds the slug. Exhausted means every derived suffix was
// rejected. A live clash leaves both flags false. Unwrap reports
// ErrSlugReserved or ErrConflict.
type SlugConflict struct {
	Reserved  bool
	Exhausted bool
}

func (e SlugConflict) Error() string {
	switch {
	case e.Reserved:
		return ErrSlugReserved.Error()
	case e.Exhausted:
		return "unique workflow slug could not be allocated"
	default:
		return "workflow slug already exists"
	}
}

func (e SlugConflict) Unwrap() error {
	if e.Reserved {
		return ErrSlugReserved
	}
	return ErrConflict
}

// CreateInput creates a workflow and its first draft from normalized YAML.
// SlugDerived is set when Slug was derived from the display name. Only that
// slug gains a numeric suffix when the unique index rejects it. An explicit
// slug, from the request body or metadata.slug, is never rewritten. When
// Slug is empty and SlugDerived is false, Create resolves the slug itself.
type CreateInput struct {
	Slug           string
	SlugDerived    bool
	Name           string
	NormalizedYAML string
	Digest         string
	Summary        workflow.Summary
	FolderID       string
}

// SaveInput is an optimistic draft update.
type SaveInput struct {
	ExpectedRevision int64
	NormalizedYAML   string
	Digest           string
	Summary          workflow.Summary
}

// PublishInput copies the current draft into an immutable version.
type PublishInput struct {
	ExpectedRevision int64
	Note             string
}

// RestoreInput copies a published version into the mutable draft.
type RestoreInput struct {
	VersionID        string
	ExpectedRevision int64
}

// StartInput starts a durable execution against a published version.
type StartInput struct {
	VersionID      string
	IdempotencyKey string
	Input          map[string]any
	CorrelationID  string
	TriggerID      string
	TriggerType    string
	RequestedBy    string
	PolicySnapshot map[string]any
	HostContext    map[string]any
	// MaxOpen caps non-terminal executions in the workspace. Zero and
	// negative skip the cap (unit tests). A positive cap is checked in
	// the start transaction so replicas cannot overshoot. Idempotent
	// replay does not take a new slot.
	MaxOpen int
}

// ClaimInput claims the next queued job in the workspace.
type ClaimInput struct {
	WorkerID   string
	Lease      time.Duration
	BindingTTL time.Duration
}

// JobActionInput is a fenced worker mutation against a claimed job.
type JobActionInput struct {
	JobID        string
	WorkerID     string
	FencingToken int64
	Lease        time.Duration
	Output       map[string]any
	Error        map[string]any
	// ApprovalTransientRetry delays a release that returns the job to
	// queued by a flat 30s ± 5s. Leave it false for every other release,
	// including worker releases and other job types. An indeterminate
	// release ignores it. The delay does not change attempt.
	ApprovalTransientRetry bool `json:"-"`
}

// JobBinding is the authenticated workspace/version/policy/expiry envelope
// issued at claim time. Workers must reject altered, expired, or
// cross-workspace bindings before a provider call.
type JobBinding struct {
	WorkspaceID       string    `json:"workspaceId"`
	TenantID          string    `json:"tenantId,omitempty"`
	WorkbenchKey      string    `json:"workbenchKey,omitempty"`
	ExecutionID       string    `json:"executionId"`
	JobID             string    `json:"jobId"`
	StepID            string    `json:"stepId"`
	WorkflowID        string    `json:"workflowId"`
	WorkflowVersionID string    `json:"workflowVersionId"`
	WorkflowDigest    string    `json:"workflowDigest"`
	PolicyDigest      string    `json:"policyDigest"`
	CorrelationID     string    `json:"correlationId,omitempty"`
	FencingToken      int64     `json:"fencingToken"`
	ExpiresAt         time.Time `json:"expiresAt"`
	LeaseExpiresAt    time.Time `json:"leaseExpiresAt"`
}

// DispatchResult is a job mutation plus its parent step/execution.
type DispatchResult struct {
	Execution Execution
	Step      ExecutionStep
	Job       ExecutionJob
	Binding   JobBinding
	Recovered int
}

// ParkedApproval is the approval inserted in the same transaction that parks
// a flow.approval gate. expires_at is the wait deadline, not this struct.
type ParkedApproval struct {
	WorkflowID        string
	WorkflowVersionID string
	WorkflowDigest    string
	ExecutionID       string
	RequestedBy       string
	NodeID            string
	NodeName          string
	Operation         string
	ApproverRole      string
	TargetKind        string
	TargetID          string
	TargetVersionID   string
	TargetDigest      string
	PolicyResourceID  string
	PolicyVersionID   string
	PolicyDigest      string
	PolicyRevision    int
}

// WaitJobInput parks a claimed or queued job without a worker lease.
// Approval, when set on a flow.approval step, is inserted in the same
// transaction. Its expires_at is the wait deadline (AvailableAt, or the
// job's available_at when the job is already waiting), not a recomputed
// clock offset.
type WaitJobInput struct {
	JobID       string
	AvailableAt time.Time
	Approval    *ParkedApproval
}

// ResumeWaitInput completes a waiting job onto an output port.
type ResumeWaitInput struct {
	JobID  string
	Port   string
	Output map[string]any
}

// RetryResult is a newly queued attempt after an authorized retry.
type RetryResult struct {
	Execution Execution
	Step      ExecutionStep
	Job       ExecutionJob
}

// EmergencyStopInput is an authorized halt of a running or queued script step.
type EmergencyStopInput struct {
	ExecutionID string
	StepID      string
	Uncertain   bool
}

// EmergencyStopResult is the durable outcome of an emergency stop.
type EmergencyStopResult struct {
	Execution Execution
	Outcome   string
	Uncertain bool
	Stopped   int
}

// AuditWrite is a redacted append-only audit insert.
type AuditWrite struct {
	Action        string
	ResourceType  string
	ResourceID    string
	Outcome       string
	CorrelationID string
	HostContext   map[string]any
	Details       map[string]any
}

// Store persists drafts, versions, and pinned executions under a server scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Workflow, Draft, error)
	List(ctx context.Context, scope isolation.Scope, filter WorkflowListFilter) ([]Workflow, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Workflow, error)
	// Delete soft-deletes one workflow. It unpublishes, disables triggers and
	// schedules, and writes workflow.deleted in the same transaction.
	// Parked runs are failed in that transaction. An in-flight job returns
	// ErrActiveExecutions and changes nothing.
	Delete(ctx context.Context, scope isolation.Scope, id string) (DeleteResult, error)
	// DeleteImpact classifies open runs with the same function Delete uses.
	DeleteImpact(ctx context.Context, scope isolation.Scope, id string) (DeleteImpact, error)
	SetWorkflowFolder(ctx context.Context, scope isolation.Scope, workflowID, folderID string) (Workflow, error)
	CreateFolder(ctx context.Context, scope isolation.Scope, in CreateFolderInput) (Folder, error)
	ListFolders(ctx context.Context, scope isolation.Scope) ([]Folder, error)
	ListFoldersPage(ctx context.Context, scope isolation.Scope, q page.Query) ([]Folder, string, error)
	GetFolder(ctx context.Context, scope isolation.Scope, folderID string) (Folder, error)
	UpdateFolder(ctx context.Context, scope isolation.Scope, folderID string, in UpdateFolderInput) (Folder, error)
	DeleteFolder(ctx context.Context, scope isolation.Scope, folderID string) error
	GetDraft(ctx context.Context, scope isolation.Scope, workflowID string) (Draft, error)
	SaveDraft(ctx context.Context, scope isolation.Scope, workflowID string, in SaveInput) (Workflow, Draft, error)
	Publish(ctx context.Context, scope isolation.Scope, workflowID string, in PublishInput) (Workflow, Version, error)
	ListVersions(ctx context.Context, scope isolation.Scope, workflowID string) ([]Version, error)
	ListVersionsPage(ctx context.Context, scope isolation.Scope, workflowID string, q page.Query) ([]Version, string, error)
	GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (Version, error)
	Compare(ctx context.Context, scope isolation.Scope, workflowID string, left, right CompareRef) (CompareResult, error)
	Restore(ctx context.Context, scope isolation.Scope, workflowID string, in RestoreInput) (Workflow, Draft, error)
	StartExecution(ctx context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error)
	PeekIdempotent(ctx context.Context, scope isolation.Scope, workflowID string, in StartInput) (Execution, error)
	GetExecution(ctx context.Context, scope isolation.Scope, workflowID, executionID string) (Execution, error)
	GetExecutionByID(ctx context.Context, scope isolation.Scope, executionID string) (Execution, error)
	ListExecutions(ctx context.Context, scope isolation.Scope, filter ExecutionListFilter) ([]Execution, error)
	ListSteps(ctx context.Context, scope isolation.Scope, executionID string) ([]ExecutionStep, error)
	GetStep(ctx context.Context, scope isolation.Scope, executionID, stepID string) (ExecutionStep, error)
	ListJobs(ctx context.Context, scope isolation.Scope, executionID string) ([]ExecutionJob, error)
	GetJob(ctx context.Context, scope isolation.Scope, jobID string) (ExecutionJob, error)
	ClaimJob(ctx context.Context, scope isolation.Scope, now time.Time, in ClaimInput) (DispatchResult, error)
	HeartbeatJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error)
	ReleaseJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error)
	CompleteJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error)
	FailJob(ctx context.Context, scope isolation.Scope, now time.Time, in JobActionInput) (DispatchResult, error)
	CancelExecution(ctx context.Context, scope isolation.Scope, now time.Time, executionID string) (Execution, error)
	EmergencyStop(ctx context.Context, scope isolation.Scope, now time.Time, in EmergencyStopInput) (EmergencyStopResult, error)
	RetryStep(ctx context.Context, scope isolation.Scope, now time.Time, executionID, stepID string, hint ...map[string]any) (RetryResult, error)
	WaitJob(ctx context.Context, scope isolation.Scope, now time.Time, in WaitJobInput) (DispatchResult, error)
	ResumeWait(ctx context.Context, scope isolation.Scope, now time.Time, in ResumeWaitInput) (DispatchResult, error)
	// AbandonIfWorkflowDeleted locks the live workflow row. A tombstone
	// fails the run with ReasonWorkflowDeleted and returns ErrWorkflowDeleted.
	// A live row returns nil. Callers that already decided an approval still
	// refuse the resume when ResumeWait returns ErrWorkflowDeleted.
	AbandonIfWorkflowDeleted(ctx context.Context, scope isolation.Scope, now time.Time, executionID string) error
	RecoverExpiredLeases(ctx context.Context, scope isolation.Scope, now time.Time) (int, error)
	ListAuditEvents(ctx context.Context, scope isolation.Scope, filter AuditListFilter) ([]AuditEvent, error)
	WriteAudit(ctx context.Context, scope isolation.Scope, in AuditWrite) (AuditEvent, error)
	PurgeExpired(ctx context.Context, scope isolation.Scope, now time.Time) (executions int, audits int, err error)
	CreateArtifact(ctx context.Context, scope isolation.Scope, in CreateArtifactInput) (Artifact, error)
	GetArtifact(ctx context.Context, scope isolation.Scope, artifactID string) (Artifact, error)
	ListArtifacts(ctx context.Context, scope isolation.Scope, filter ArtifactListFilter) ([]Artifact, error)
	DeleteArtifact(ctx context.Context, scope isolation.Scope, artifactID string) error
	SetLegalHold(ctx context.Context, scope isolation.Scope, artifactID string, in LegalHoldInput) (Artifact, error)
	CreateDownloadGrant(ctx context.Context, scope isolation.Scope, artifactID string, now time.Time, ttl time.Duration) (DownloadGrant, error)
	GetDownloadGrant(ctx context.Context, scope isolation.Scope, grantID string, now time.Time) (DownloadGrant, Artifact, error)
	PlanRetentionPurge(ctx context.Context, scope isolation.Scope, now time.Time) (RetentionPlan, error)
	FindCredentialRefs(ctx context.Context, scope isolation.Scope, credentialID string) ([]CredentialRef, error)
	// AnnotateRetryCapabilities fills capabilities.retry on exec and steps
	// from the same eligibility function RetryStep uses. steps is updated
	// in place. The pin hint used by POST retry is not applied.
	AnnotateRetryCapabilities(ctx context.Context, scope isolation.Scope, exec *Execution, steps []ExecutionStep) error
}

// Credential reference kinds returned to the vault for usage/deletion impact.
const (
	CredentialRefDraft     = "draft"
	CredentialRefVersion   = "version"
	CredentialRefExecution = "execution"
	CredentialRefTrigger   = "trigger"
)

// CredentialRef is a secret-free pointer from a workflow document or pin
// to a credential UUID found in normalized YAML.
type CredentialRef struct {
	Kind            string `json:"kind"`
	WorkflowID      string `json:"workflowId"`
	WorkflowSlug    string `json:"workflowSlug"`
	WorkflowName    string `json:"workflowName"`
	VersionID       string `json:"versionId,omitempty"`
	VersionNumber   int    `json:"versionNumber,omitempty"`
	ExecutionID     string `json:"executionId,omitempty"`
	ExecutionStatus string `json:"executionStatus,omitempty"`
}
