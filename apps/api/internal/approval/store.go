// Package approval persists policy-bound approval requirements and decisions.
package approval

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/page"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
)

// Persistence errors.
var (
	ErrNotFound          = errors.New("not found")
	ErrConflict          = errors.New("conflict")
	ErrInvalid           = errors.New("invalid")
	ErrNoScope           = errors.New("workspace scope is not set")
	ErrStoreUnavailable  = errors.New("approval store is unavailable")
	ErrSelfApproval      = errors.New("requester cannot decide their own approval")
	ErrNotPending        = errors.New("approval is not pending")
	ErrClosed            = errors.New("approval is closed")
	ErrExpired           = errors.New("approval has expired")
	ErrInvalidated       = errors.New("approval binding is no longer valid")
	ErrStaleAuth         = errors.New("authorization is no longer valid")
	ErrForbidden         = errors.New("forbidden")
	ErrBindingUnresolved = errors.New("approval binding is unresolved")
)

// Status values.
const (
	StatusPending     = "pending"
	StatusApproved    = "approved"
	StatusRejected    = "rejected"
	StatusExpired     = "expired"
	StatusInvalidated = "invalidated"
	StatusCanceled    = "canceled"
)

// Close reasons recorded when a run ends before a decision. No decider is stored.
const (
	ReasonRunCanceled             = "run_canceled"
	ReasonWorkflowDeleted         = "workflow_deleted"
	ReasonRequirementUnresolvable = "requirement_unresolvable"
)

// Decision values accepted by Decide.
const (
	DecisionApproved = "approved"
	DecisionRejected = "rejected"
)

// Event types.
const (
	EventCreated     = "created"
	EventApproved    = "approved"
	EventRejected    = "rejected"
	EventExpired     = "expired"
	EventInvalidated = "invalidated"
	EventCanceled    = "canceled"
)

// Record is a workspace-owned approval requirement.
type Record struct {
	ID                 string     `json:"id"`
	WorkflowID         string     `json:"workflowId"`
	WorkflowVersionID  string     `json:"workflowVersionId"`
	WorkflowDigest     string     `json:"workflowDigest"`
	ExecutionID        string     `json:"executionId,omitempty"`
	NodeID             string     `json:"nodeId"`
	NodeName           string     `json:"nodeName,omitempty"`
	Operation          string     `json:"operation"`
	TargetKind         string     `json:"targetKind,omitempty"`
	TargetID           string     `json:"targetId,omitempty"`
	TargetVersionID    string     `json:"targetVersionId,omitempty"`
	TargetDigest       string     `json:"targetDigest,omitempty"`
	PolicyResourceID   string     `json:"policyResourceId,omitempty"`
	PolicyVersionID    string     `json:"policyVersionId,omitempty"`
	PolicyDigest       string     `json:"policyDigest,omitempty"`
	PolicyRevision     int        `json:"policyRevision,omitempty"`
	BindingFingerprint string     `json:"bindingFingerprint"`
	ApproverRole       string     `json:"approverRole"`
	ApproverUserID     string     `json:"approverUserId,omitempty"`
	ApproverGroupID    string     `json:"approverGroupId,omitempty"`
	Status             string     `json:"status"`
	ExpiresAt          time.Time  `json:"expiresAt"`
	RequestedBy        string     `json:"requestedBy,omitempty"`
	DecidedBy          string     `json:"decidedBy,omitempty"`
	DecidedAt          *time.Time `json:"decidedAt,omitempty"`
	DecisionNote       string     `json:"decisionNote,omitempty"`
	CloseReason        string     `json:"closeReason,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

// Event is a secret-free approval audit row.
type Event struct {
	ID         string         `json:"id"`
	ApprovalID string         `json:"approvalId"`
	EventType  string         `json:"eventType"`
	ActorID    string         `json:"actorId,omitempty"`
	Details    map[string]any `json:"details"`
	OccurredAt time.Time      `json:"occurredAt"`
}

// Filter lists approvals. Page, when Bound, is the HTTP keyset page.
// Search matches node id, node name, operation, and status — never decision notes.
type Filter struct {
	Status            string
	WorkflowID        string
	WorkflowVersionID string
	ExecutionID       string
	Page              page.Query
	// Actionable limits a pending list to rows this caller may decide
	// from the stored role and target. It does not re-evaluate policy.
	Actionable  bool
	ActorID     string
	ActorRoles  []string
	ActorGroups []string
}

// CreateInput materializes one evaluation requirement.
type CreateInput struct {
	WorkflowID        string
	WorkflowVersionID string
	WorkflowDigest    string
	ExecutionID       string
	RequestedBy       string
	Requirement       policy.Requirement
}

// DecideInput is a fresh-authorization decision.
// Resolve, when set, re-derives the gate inside Decide. Postgres and memory
// both authorize against that requirement, not the stored role. The API
// always sets it. A resolve error denies the decision and writes nothing.
type DecideInput struct {
	Decision string
	Note     string
	Now      time.Time
	Heads    CurrentHeads
	Resolve  func(ctx context.Context, scope isolation.Scope, rec Record) (policy.Requirement, error)
	Roles    []string
	// GroupIDs are the caller's group memberships. A gate with
	// ApproverGroupID allows only a member of that group.
	// When Subjects is set, group membership is read from that directory
	// instead, so a caller cannot claim a group they are not in.
	GroupIDs []string
	// Subjects checks that a target user is still a workspace member and
	// that a caller is a current member of a target group. Nil skips that
	// live check and uses GroupIDs.
	Subjects SubjectDirectory
}

// InvalidateInput marks matching pending/approved rows invalidated.
type InvalidateInput struct {
	TargetID         string
	PolicyResourceID string
	ResourceID       string
	Reason           string
	Now              time.Time
}

// CurrentHeads is the live published state used to fail-close stale bindings.
type CurrentHeads struct {
	WorkflowDigest        string
	TargetLatestVersionID string
	PolicyLatestVersionID string
	TargetDisabled        bool
	PolicyDisabled        bool
}

// Catalog is the UI vocabulary for approval surfaces.
type Catalog struct {
	Statuses               []string `json:"statuses"`
	Decisions              []string `json:"decisions"`
	DefaultExpiry          string   `json:"defaultExpiresIn"`
	WaitResumeEnabled      bool     `json:"waitResumeEnabled"`
	ResumeRoute            string   `json:"resumeRoute"`
	WaitSurvivesWorkerLoss bool     `json:"waitSurvivesWorkerLoss"`
	SelfApprovalDenied     bool     `json:"selfApprovalDenied"`
	FreshAuthRequired      bool     `json:"freshAuthRequired"`
	Help                   string   `json:"help"`
}

// TypeCatalog returns stable status/decision names.
func TypeCatalog() Catalog {
	return Catalog{
		Statuses:               []string{StatusPending, StatusApproved, StatusRejected, StatusExpired, StatusInvalidated, StatusCanceled},
		Decisions:              []string{DecisionApproved, DecisionRejected},
		DefaultExpiry:          "PT1H",
		WaitResumeEnabled:      true,
		ResumeRoute:            "POST /api/v1/approvals/{approvalId}/decide",
		WaitSurvivesWorkerLoss: true,
		SelfApprovalDenied:     true,
		FreshAuthRequired:      true,
		Help:                   "Mid-run flow.approval parks a durable waiting job with no worker lease. Decide is resume: approved/rejected ports. Expiry and binding change resume on expired. Requester self-approval is denied. Decide rechecks approval.decide on the server and rebuilds the full requirement (role, target user or group, and policy pin) from the pinned workflow version.",
	}
}

// Store persists approval requirements under server-derived workspace scope.
type Store interface {
	Create(ctx context.Context, scope isolation.Scope, in CreateInput) (Record, error)
	List(ctx context.Context, scope isolation.Scope, filter Filter) ([]Record, error)
	Get(ctx context.Context, scope isolation.Scope, id string) (Record, error)
	Decide(ctx context.Context, scope isolation.Scope, id string, in DecideInput) (Record, error)
	// ClosePendingForExecution cancels approvals still pending on a run.
	// No decider is recorded. reason is run_canceled or workflow_deleted.
	ClosePendingForExecution(ctx context.Context, scope isolation.Scope, executionID, reason string, now time.Time) error
	Refresh(ctx context.Context, scope isolation.Scope, id string, heads CurrentHeads, now time.Time) (Record, error)
	InvalidateMatching(ctx context.Context, scope isolation.Scope, in InvalidateInput) (int, error)
	Events(ctx context.Context, scope isolation.Scope, id string) ([]Event, error)
}

// BindingFingerprint is the immutable bind of version + target + policy +
// operation + approver role. Pass a non-empty executionID only for mid-run
// waits so pre-run fingerprints stay stable.
func BindingFingerprint(workspaceID, workflowVersionID, workflowDigest, targetVersionID, policyVersionID, policyDigest, operation, nodeID, approverRole, executionID, approverUserID, approverGroupID string) string {
	return parkedapproval.Fingerprint(workspaceID, workflowVersionID, workflowDigest, targetVersionID, policyVersionID, policyDigest, operation, nodeID, approverRole, executionID, approverUserID, approverGroupID)
}

// Freshness reports whether a record is still usable against current heads.
func Freshness(rec Record, heads CurrentHeads, now time.Time) (status, reason string) {
	if rec.Status == StatusRejected || rec.Status == StatusExpired || rec.Status == StatusInvalidated || rec.Status == StatusCanceled {
		return rec.Status, ""
	}
	if !rec.ExpiresAt.IsZero() && !now.Before(rec.ExpiresAt) {
		return StatusExpired, "approval has expired"
	}
	if heads.WorkflowDigest != "" && rec.WorkflowDigest != "" && heads.WorkflowDigest != rec.WorkflowDigest {
		return StatusInvalidated, "workflow version digest changed"
	}
	if rec.TargetVersionID != "" && heads.TargetLatestVersionID != "" && heads.TargetLatestVersionID != rec.TargetVersionID {
		return StatusInvalidated, "target revision changed"
	}
	if rec.PolicyVersionID != "" && heads.PolicyLatestVersionID != "" && heads.PolicyLatestVersionID != rec.PolicyVersionID {
		return StatusInvalidated, "policy revision changed"
	}
	if heads.TargetDisabled && rec.TargetID != "" {
		return StatusInvalidated, "target is disabled"
	}
	if heads.PolicyDisabled && rec.PolicyResourceID != "" {
		return StatusInvalidated, "policy is disabled"
	}
	return rec.Status, ""
}

// NormalizeDecision maps approve/reject aliases to stored status.
func NormalizeDecision(raw string) (string, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "approved", "approve":
		return DecisionApproved, nil
	case "rejected", "reject":
		return DecisionRejected, nil
	default:
		return "", ErrInvalid
	}
}

// HasApproverRole reports whether the caller may decide for the required role.
// Admin may decide any role except their own request (checked separately).
func HasApproverRole(roles []string, required string) bool {
	required = strings.TrimSpace(required)
	if required == "" {
		required = "approver"
	}
	for _, role := range roles {
		if role == "admin" || role == required {
			return true
		}
	}
	return false
}

// MayAct reports whether actorID may decide rec from the stored role and
// target. Admin satisfies any role. A target user or group is not satisfied
// by admin: the caller must be that user or a member of that group.
func MayAct(actorID string, roles, groups []string, rec Record) bool {
	if !HasApproverRole(roles, rec.ApproverRole) {
		return false
	}
	if id := strings.TrimSpace(rec.ApproverUserID); id != "" && id != strings.TrimSpace(actorID) {
		return false
	}
	if id := strings.TrimSpace(rec.ApproverGroupID); id != "" && !containsID(groups, id) {
		return false
	}
	return true
}

func containsID(ids []string, want string) bool {
	for _, id := range ids {
		if strings.TrimSpace(id) == want {
			return true
		}
	}
	return false
}
