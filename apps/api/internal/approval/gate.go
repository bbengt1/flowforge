package approval

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5/pgconn"
)

// VersionSource loads the run's pinned workflow version.
type VersionSource interface {
	GetVersion(ctx context.Context, scope isolation.Scope, workflowID, versionID string) (wfstore.Version, error)
}

// PinSource resolves published operational pins for a workflow definition.
type PinSource interface {
	Resolve(ctx context.Context, scope isolation.Scope, refs []opsconfig.Ref) ([]opsconfig.Pin, error)
}

// ResolvePins resolves definition refs and any policyId those pins name.
// A nil source evaluates with no pins. A resolve error is returned as-is
// so the caller can fail closed.
func ResolvePins(ctx context.Context, scope isolation.Scope, ops PinSource, yamlDoc string) ([]opsconfig.Pin, error) {
	return resolvePins(ctx, scope, ops, yamlDoc, nil)
}

// resolvePins resolves definition refs. pinned, when set, selects each
// policy's run pin instead of the latest published revision, so role and
// expiry come from the revision the run started with.
func resolvePins(ctx context.Context, scope isolation.Scope, ops PinSource, yamlDoc string, pinned []runPin) ([]opsconfig.Pin, error) {
	if ops == nil {
		return []opsconfig.Pin{}, nil
	}
	refs := opsconfig.ExtractRefs(yamlDoc)
	if len(refs) == 0 {
		return []opsconfig.Pin{}, nil
	}
	stampRunPins(refs, pinned)
	pins, err := ops.Resolve(ctx, scope, refs)
	if err != nil {
		return nil, err
	}
	seen := map[string]struct{}{}
	for _, pin := range pins {
		seen[pin.ResourceID] = struct{}{}
	}
	var extra []opsconfig.Ref
	for _, pin := range pins {
		if pin.Spec == nil {
			continue
		}
		id, _ := pin.Spec["policyId"].(string)
		id = strings.TrimSpace(id)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		extra = append(extra, opsconfig.Ref{Kind: opsconfig.KindPolicy, ResourceID: id})
	}
	if len(extra) == 0 {
		return pins, nil
	}
	stampRunPins(extra, pinned)
	more, err := ops.Resolve(ctx, scope, extra)
	if err != nil {
		return nil, err
	}
	return append(pins, more...), nil
}

func stampRunPins(refs []opsconfig.Ref, pinned []runPin) {
	if len(refs) == 0 || len(pinned) == 0 {
		return
	}
	byID := map[string]string{}
	for _, pin := range pinned {
		if pin.PolicyResourceID == "" || pin.PolicyVersionID == "" {
			continue
		}
		byID[pin.PolicyResourceID] = pin.PolicyVersionID
	}
	for i := range refs {
		if versionID, ok := byID[refs[i].ResourceID]; ok {
			refs[i].VersionID = versionID
		}
	}
}

// ResolveGateRequirement re-derives the requirement for one node from the
// pinned workflow version. A gate matches its wait requirement. A pre-run
// approval matches the non-wait requirement for that same node. The
// requirement is the approver role and the policy pin for that node.
// ErrBindingUnresolved is only a definitive miss: the loader is absent,
// the pinned version is not found, pin resolution failed deterministically,
// policy evaluation failed, or no requirement matches. A database, network,
// context, or timeout failure returns ErrBindingTransient. The caller
// retries that and does not cancel or correct the row.
func ResolveGateRequirement(ctx context.Context, scope isolation.Scope, versions VersionSource, ops PinSource, workflowID, versionID, nodeID string, now time.Time) (policy.Requirement, error) {
	return resolveGateRequirement(ctx, scope, versions, ops, workflowID, versionID, nodeID, now, nil)
}

func resolveGateRequirement(ctx context.Context, scope isolation.Scope, versions VersionSource, ops PinSource, workflowID, versionID, nodeID string, now time.Time, pinned []runPin) (policy.Requirement, error) {
	if versions == nil {
		return policy.Requirement{}, fmt.Errorf("%w: workflow version is not available", ErrBindingUnresolved)
	}
	ver, err := versions.GetVersion(ctx, scope, workflowID, versionID)
	if err != nil {
		if privilegeDenied(err) || !errors.Is(err, wfstore.ErrNotFound) {
			return policy.Requirement{}, fmt.Errorf("%w: version lookup failed", ErrBindingTransient)
		}
		return policy.Requirement{}, fmt.Errorf("%w: version lookup failed", ErrBindingUnresolved)
	}
	pins, err := resolvePins(ctx, scope, ops, ver.DefinitionYAML, pinned)
	if err != nil {
		if privilegeDenied(err) || !pinFailureDefinitive(err) {
			return policy.Requirement{}, fmt.Errorf("%w: pin resolve failed", ErrBindingTransient)
		}
		return policy.Requirement{}, fmt.Errorf("%w: pin resolve failed", ErrBindingUnresolved)
	}
	eval, err := policy.Evaluate(policy.Input{
		YAML:              ver.DefinitionYAML,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		Pins:              pins,
		Now:               now,
	})
	if err != nil {
		return policy.Requirement{}, fmt.Errorf("%w: policy evaluation failed", ErrBindingUnresolved)
	}
	nodeID = strings.TrimSpace(nodeID)
	var matched *policy.Requirement
	for i := range eval.Requirements {
		item := eval.Requirements[i]
		if item.NodeID != nodeID {
			continue
		}
		if item.Wait {
			return item, nil
		}
		if matched == nil {
			copied := item
			matched = &copied
		}
	}
	if matched != nil {
		return *matched, nil
	}
	return policy.Requirement{}, fmt.Errorf("%w: approval requirement is missing", ErrBindingUnresolved)
}

// ProjectRequirement copies the re-derived approver role and policy pin
// onto rec and recomputes the fingerprint. Node, operation, and target
// fields stay as stored. changed is false when the stored row already
// matches. ExpiresAt is left alone: it is the wait deadline, not a new evaluation.
func ProjectRequirement(rec Record, workspaceID string, req policy.Requirement) (Record, bool) {
	next := rec
	role := strings.TrimSpace(req.ApproverRole)
	if role == "" {
		role = "approver"
	}
	next.ApproverRole = role
	next.PolicyResourceID = req.PolicyResourceID
	next.PolicyVersionID = req.PolicyVersionID
	next.PolicyDigest = req.PolicyDigest
	next.PolicyRevision = req.PolicyRevision
	next.BindingFingerprint = BindingFingerprint(workspaceID, rec.WorkflowVersionID, rec.WorkflowDigest, rec.TargetVersionID, req.PolicyVersionID, req.PolicyDigest, rec.Operation, rec.NodeID, role, rec.ExecutionID)
	changed := next.ApproverRole != rec.ApproverRole ||
		next.PolicyResourceID != rec.PolicyResourceID ||
		next.PolicyVersionID != rec.PolicyVersionID ||
		next.PolicyDigest != rec.PolicyDigest ||
		next.PolicyRevision != rec.PolicyRevision ||
		next.BindingFingerprint != rec.BindingFingerprint
	return next, changed
}

// StoredRequirement echoes the stored approver role and policy pin so a
// decision that is not a correction leaves those fields unchanged.
func StoredRequirement(rec Record) policy.Requirement {
	return policy.Requirement{
		NodeID:           rec.NodeID,
		NodeName:         rec.NodeName,
		Operation:        rec.Operation,
		ApproverRole:     rec.ApproverRole,
		TargetKind:       rec.TargetKind,
		TargetID:         rec.TargetID,
		TargetVersionID:  rec.TargetVersionID,
		TargetDigest:     rec.TargetDigest,
		PolicyResourceID: rec.PolicyResourceID,
		PolicyVersionID:  rec.PolicyVersionID,
		PolicyDigest:     rec.PolicyDigest,
		PolicyRevision:   rec.PolicyRevision,
		ExpiresAt:        rec.ExpiresAt,
	}
}

// runPin is the workflow version and one policy revision the run was started with.
type runPin struct {
	WorkflowVersionID string
	WorkflowDigest    string
	PolicyResourceID  string
	PolicyVersionID   string
	PolicyDigest      string
	PolicyRevision    int
}

// privilegeDenied reports SQLSTATE 42501. mapDBErr keeps that code wrapped
// with not-found so other callers stay unchanged, and a grant failure must
// retry instead of canceling the approval.
func privilegeDenied(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42501"
}

// overlayRunPolicy keeps the run's pinned policy on the rebuilt requirement
// so a newer published revision is not written onto the pending row.
func overlayRunPolicy(req policy.Requirement, pin runPin) policy.Requirement {
	if pin.PolicyVersionID == "" {
		return req
	}
	req.PolicyResourceID = pin.PolicyResourceID
	req.PolicyVersionID = pin.PolicyVersionID
	req.PolicyDigest = pin.PolicyDigest
	req.PolicyRevision = pin.PolicyRevision
	return req
}

func correctionDetails(before, after Record) map[string]any {
	return map[string]any{
		"approverRole":     map[string]any{"from": before.ApproverRole, "to": after.ApproverRole},
		"policyResourceId": map[string]any{"from": before.PolicyResourceID, "to": after.PolicyResourceID},
		"policyVersionId":  map[string]any{"from": before.PolicyVersionID, "to": after.PolicyVersionID},
		"policyDigest":     map[string]any{"from": before.PolicyDigest, "to": after.PolicyDigest},
		"policyRevision":   map[string]any{"from": before.PolicyRevision, "to": after.PolicyRevision},
	}
}

func pinFailureDefinitive(err error) bool {
	return errors.Is(err, opsconfig.ErrNotFound) ||
		errors.Is(err, opsconfig.ErrNotPublished) ||
		errors.Is(err, opsconfig.ErrDraftNotUsable) ||
		errors.Is(err, opsconfig.ErrDisabled) ||
		errors.Is(err, opsconfig.ErrCrossWorkspace) ||
		errors.Is(err, opsconfig.ErrInvalid) ||
		errors.Is(err, opsconfig.ErrNoScope) ||
		errors.Is(err, opsconfig.ErrImmutable) ||
		errors.Is(err, opsconfig.ErrConflict) ||
		errors.Is(err, opsconfig.ErrRevisionConflict)
}

// authorizeDerived re-derives the approver role and policy pin. A nil
// Resolve denies. ErrBindingUnresolved and ErrBindingTransient are returned
// as-is and the caller records nothing. Any other resolve error is transient
// unless it is a definitive pin or not-found failure. When the caller may
// not decide the rebuilt requirement, next is still returned with
// ErrForbidden so the caller can commit that correction before the denial.
func authorizeDerived(ctx context.Context, scope isolation.Scope, rec Record, in DecideInput) (Record, bool, error) {
	if in.Resolve == nil {
		return Record{}, false, ErrForbidden
	}
	req, err := in.Resolve(ctx, scope, rec)
	if err != nil {
		if errors.Is(err, ErrBindingUnresolved) || errors.Is(err, ErrBindingTransient) {
			return Record{}, false, err
		}
		if errors.Is(err, wfstore.ErrNotFound) || pinFailureDefinitive(err) {
			return Record{}, false, fmt.Errorf("%w: %v", ErrBindingUnresolved, err)
		}
		return Record{}, false, fmt.Errorf("%w: %v", ErrBindingTransient, err)
	}
	next, changed := ProjectRequirement(rec, scope.WorkspaceID(), req)
	if !MayAct(in.Roles, next) {
		return next, changed, ErrForbidden
	}
	return next, changed, nil
}
