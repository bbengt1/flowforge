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
	if ops == nil {
		return []opsconfig.Pin{}, nil
	}
	refs := opsconfig.ExtractRefs(yamlDoc)
	if len(refs) == 0 {
		return []opsconfig.Pin{}, nil
	}
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
	more, err := ops.Resolve(ctx, scope, extra)
	if err != nil {
		return nil, err
	}
	return append(pins, more...), nil
}

// ResolveGateRequirement re-derives the requirement for one node from the
// pinned workflow version. A gate matches its wait requirement. A pre-run
// approval matches the non-wait requirement for that same node. A missing
// loader, a version lookup error, an evaluate error, no matching
// requirement, or a target user or group record that no longer exists
// returns ErrBindingUnresolved. The caller denies the decision and does
// not record one. A user removed from the workspace, or a group that still
// exists but has no members, rebuilds: membership can return. subjects may
// be nil when the caller has no directory; production passes one.
func ResolveGateRequirement(ctx context.Context, scope isolation.Scope, versions VersionSource, ops PinSource, subjects SubjectDirectory, workflowID, versionID, nodeID string, now time.Time) (policy.Requirement, error) {
	if versions == nil {
		return policy.Requirement{}, fmt.Errorf("%w: workflow version is not available", ErrBindingUnresolved)
	}
	ver, err := versions.GetVersion(ctx, scope, workflowID, versionID)
	if err != nil {
		return policy.Requirement{}, fmt.Errorf("%w: version lookup failed", ErrBindingUnresolved)
	}
	pins, err := ResolvePins(ctx, scope, ops, ver.DefinitionYAML)
	if err != nil {
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
			if err := confirmSubjectRecords(ctx, scope, subjects, item); err != nil {
				return policy.Requirement{}, err
			}
			return item, nil
		}
		if matched == nil {
			copied := item
			matched = &copied
		}
	}
	if matched != nil {
		if err := confirmSubjectRecords(ctx, scope, subjects, *matched); err != nil {
			return policy.Requirement{}, err
		}
		return *matched, nil
	}
	return policy.Requirement{}, fmt.Errorf("%w: approval requirement is missing", ErrBindingUnresolved)
}

// ProjectRequirement copies the re-derived role and binding onto rec and
// recomputes the fingerprint. changed is false when the stored row already
// matches. ExpiresAt is left alone: it is the wait deadline, not a new evaluation.
func ProjectRequirement(rec Record, workspaceID string, req policy.Requirement) (Record, bool) {
	next := rec
	role := strings.TrimSpace(req.ApproverRole)
	if role == "" {
		role = "approver"
	}
	op := strings.TrimSpace(req.Operation)
	if op == "" {
		op = rec.Operation
	}
	next.ApproverRole = role
	next.ApproverUserID = strings.TrimSpace(req.ApproverUserID)
	next.ApproverGroupID = strings.TrimSpace(req.ApproverGroupID)
	next.NodeName = req.NodeName
	next.Operation = op
	next.TargetKind = req.TargetKind
	next.TargetID = req.TargetID
	next.TargetVersionID = req.TargetVersionID
	next.TargetDigest = req.TargetDigest
	next.PolicyResourceID = req.PolicyResourceID
	next.PolicyVersionID = req.PolicyVersionID
	next.PolicyDigest = req.PolicyDigest
	next.PolicyRevision = req.PolicyRevision
	next.BindingFingerprint = BindingFingerprint(workspaceID, rec.WorkflowVersionID, rec.WorkflowDigest, req.TargetVersionID, req.PolicyVersionID, req.PolicyDigest, op, rec.NodeID, role, rec.ExecutionID, next.ApproverUserID, next.ApproverGroupID)
	changed := next.ApproverRole != rec.ApproverRole ||
		next.ApproverUserID != rec.ApproverUserID ||
		next.ApproverGroupID != rec.ApproverGroupID ||
		next.NodeName != rec.NodeName ||
		next.Operation != rec.Operation ||
		next.TargetKind != rec.TargetKind ||
		next.TargetID != rec.TargetID ||
		next.TargetVersionID != rec.TargetVersionID ||
		next.TargetDigest != rec.TargetDigest ||
		next.PolicyResourceID != rec.PolicyResourceID ||
		next.PolicyVersionID != rec.PolicyVersionID ||
		next.PolicyDigest != rec.PolicyDigest ||
		next.PolicyRevision != rec.PolicyRevision ||
		next.BindingFingerprint != rec.BindingFingerprint
	return next, changed
}

// authorizeDerived re-derives the full requirement. A resolve error returns
// ErrBindingUnresolved and the caller records nothing. When the caller may
// not decide the rebuilt requirement, next is still returned with
// ErrForbidden so the caller can commit that correction before the denial.
func authorizeDerived(ctx context.Context, scope isolation.Scope, rec Record, in DecideInput) (Record, bool, error) {
	if in.Resolve == nil {
		return rec, false, nil
	}
	req, err := in.Resolve(ctx, scope, rec)
	if err != nil {
		if errors.Is(err, ErrBindingUnresolved) {
			return Record{}, false, err
		}
		return Record{}, false, fmt.Errorf("%w: %v", ErrBindingUnresolved, err)
	}
	next, changed := ProjectRequirement(rec, scope.WorkspaceID(), req)
	ok, err := targetAllows(ctx, scope, in, next)
	if err != nil {
		return Record{}, false, fmt.Errorf("%w: approver membership lookup failed", ErrBindingUnresolved)
	}
	if !ok {
		return next, changed, ErrForbidden
	}
	return next, changed, nil
}

// targetAllows is MayAct plus a live membership check when a directory is
// present. The stored user or group id is not enough: a removed member or
// an empty group stays pending, and a caller who is not a current member
// of that target is denied.
func targetAllows(ctx context.Context, scope isolation.Scope, in DecideInput, rec Record) (bool, error) {
	if in.Subjects == nil {
		return MayAct(scope.ActorID(), in.Roles, in.GroupIDs, rec), nil
	}
	if !HasApproverRole(in.Roles, rec.ApproverRole) {
		return false, nil
	}
	if id := strings.TrimSpace(rec.ApproverUserID); id != "" && id != strings.TrimSpace(scope.ActorID()) {
		return false, nil
	}
	if id := strings.TrimSpace(rec.ApproverUserID); id != "" {
		ok, err := in.Subjects.UserIsWorkspaceMember(ctx, scope.WorkspaceID(), id)
		if err != nil || !ok {
			return false, err
		}
	}
	if id := strings.TrimSpace(rec.ApproverGroupID); id != "" {
		ok, err := in.Subjects.UserInGroup(ctx, scope.WorkspaceID(), id, scope.ActorID())
		if err != nil || !ok {
			return false, err
		}
	}
	return true, nil
}
