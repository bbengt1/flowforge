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
	// ErrBindingTransient is a database, network, context, or timeout
	// failure while rebuilding a requirement. It is not a missing version
	// or a deterministic evaluation failure. Callers retry and record nothing.
	ErrBindingTransient = errors.New("approval binding lookup failed temporarily")
	// ErrApproverNotTargeted is a targeted gate decided by someone who is
	// not a snapshot user, not a live snapshot group member, and not a
	// non-requester admin. Nothing is recorded.
	ErrApproverNotTargeted = errors.New("caller is not a targeted approver")
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
	EventCorrected   = "corrected"
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
	Status             string     `json:"status"`
	ExpiresAt          time.Time  `json:"expiresAt"`
	RequestedBy        string     `json:"requestedBy,omitempty"`
	DecidedBy          string     `json:"decidedBy,omitempty"`
	DecidedAt          *time.Time `json:"decidedAt,omitempty"`
	DecisionNote       string     `json:"decisionNote,omitempty"`
	CloseReason        string     `json:"closeReason,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`

	// ApproversDigest is '' when untargeted. It is the authority on
	// whether the row is targeted, not whether snapshot rows exist.
	ApproversDigest string `json:"-"`
	// ApproverUserIDs and ApproverGroupIDs are the park-time snapshot.
	ApproverUserIDs  []string `json:"-"`
	ApproverGroupIDs []string `json:"-"`
	// CloseReasonDetails carries cause no_eligible_decider when known.
	CloseReasonDetails map[string]any `json:"closeReasonDetails,omitempty"`
	// Approvers and Capabilities are filled in by the API layer.
	Approvers    *Approvers    `json:"approvers,omitempty"`
	Capabilities *Capabilities `json:"capabilities,omitempty"`
}

// Targeted reports whether the gate names approvers.
func (r Record) Targeted() bool { return r.ApproversDigest != "" }

// PrincipalRef is a display name and UUID only.
type PrincipalRef struct {
	ID          string `json:"id"`
	DisplayName string `json:"displayName"`
}

// Approvers is the API view of a targeted gate's snapshot.
type Approvers struct {
	Users  []PrincipalRef `json:"users"`
	Groups []PrincipalRef `json:"groups"`
}

// Capabilities is the caller's read-only view of what they may do.
type Capabilities struct {
	Decide DecideCapability `json:"decide"`
}

// DecideCapability mirrors decide's checks on the stored row.
type DecideCapability struct {
	Allowed bool   `json:"allowed"`
	Via     string `json:"via,omitempty"`
	Code    string `json:"code,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// Decide routes and capability codes.
const (
	ViaTarget        = "target"
	ViaAdminOverride = "admin_override"

	CapMissingPermission   = "missing_permission"
	CapSelfApproval        = "self_approval"
	CapRoleMismatch        = "role_mismatch"
	CapApproverNotTargeted = "approver_not_targeted"
	CapNotPending          = "not_pending"
	CapApprovalClosed      = "approval_closed"

	// AuditDecidedByAdminOverride is the audit action for an override.
	AuditDecidedByAdminOverride = "approval.decided_by_admin_override"
	// CauseNoEligibleDecider is the requirement_unresolvable cause for a
	// targeted gate nobody but the requester could decide.
	CauseNoEligibleDecider = parkedapproval.CauseNoEligibleDecider
)

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
	// from the stored role. It does not re-evaluate policy.
	//
	// On a targeted row the caller must also be a snapshot user or a live
	// member of a snapshot group, unless they are an admin who is not the
	// requester (admin override).
	Actionable bool
	// AwaitingMe limits to pending rows the caller may decide without an
	// admin override: untargeted rows they hold the role for, and targeted
	// rows that name them directly or through a group. Never the
	// requester's own rows.
	AwaitingMe bool
	ActorID    string
	ActorRoles []string
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
// always sets it. A nil Resolve denies the decision. A definitive resolve
// error denies and writes nothing. A transient resolve error writes nothing
// and is returned for the caller to retry.
type DecideInput struct {
	Decision string
	Note     string
	Now      time.Time
	Heads    CurrentHeads
	Resolve  func(ctx context.Context, scope isolation.Scope, rec Record) (policy.Requirement, error)
	Roles    []string
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
		Help:                   "Mid-run flow.approval parks a durable waiting job with no worker lease. Decide is resume: approved/rejected ports. Expiry and binding change resume on expired. Requester self-approval is denied. Decide rechecks approval.decide on the server and rebuilds the requirement (approver role and policy pin) from the pinned workflow version.",
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
	// TargetsCaller reports, per record id, whether userID is a snapshot
	// user or a live eligible member of a snapshot group. Untargeted rows
	// are omitted. Read-only; decide stays authoritative.
	TargetsCaller(ctx context.Context, scope isolation.Scope, recs []Record, userID string) (map[string]bool, error)
}

// BindingFingerprint is the immutable bind of version + target + policy +
// operation + approver role. Pass a non-empty executionID only for mid-run
// waits so pre-run fingerprints stay stable.
func BindingFingerprint(workspaceID, workflowVersionID, workflowDigest, targetVersionID, policyVersionID, policyDigest, operation, nodeID, approverRole, executionID, approversDigest string) string {
	return parkedapproval.Fingerprint(workspaceID, workflowVersionID, workflowDigest, targetVersionID, policyVersionID, policyDigest, operation, nodeID, approverRole, executionID, approversDigest)
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

// MayAct reports whether the caller may decide rec from the stored role.
// Admin satisfies any role.
func MayAct(roles []string, rec Record) bool {
	return HasApproverRole(roles, rec.ApproverRole)
}
