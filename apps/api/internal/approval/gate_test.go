package approval

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const adminGateDefinition = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: admin-gate
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        expiresIn: PT1H
  edges: []
`

type staticVersion struct {
	ver wfstore.Version
	err error
}

func (s staticVersion) GetVersion(context.Context, isolation.Scope, string, string) (wfstore.Version, error) {
	if s.err != nil {
		return wfstore.Version{}, s.err
	}
	return s.ver, nil
}

func TestResolveGateRequirement(t *testing.T) {
	ctx := context.Background()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	ver := wfstore.Version{ID: "55555555-5555-4555-8555-555555555555", DefinitionYAML: adminGateDefinition, Digest: "sha256:" + strings.Repeat("a", 64)}

	req, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, nil, "44444444-4444-4444-8444-444444444444", ver.ID, "gate", now)
	if err != nil {
		t.Fatal(err)
	}
	if req.ApproverRole != "admin" || !req.Wait || req.TargetID != "" || req.PolicyResourceID != "" {
		t.Fatalf("requirement = %+v", req)
	}

	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{err: wfstore.ErrNotFound}, nil, ver.WorkflowID, ver.ID, "gate", now); !errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("version lookup = %v", err)
	}
	bad := ver
	bad.DefinitionYAML = "kind: nope\n"
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: bad}, nil, ver.WorkflowID, ver.ID, "gate", now); !errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("evaluate = %v", err)
	}
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, nil, ver.WorkflowID, ver.ID, "other", now); !errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("missing requirement = %v", err)
	}
}

func TestMemoryDecideRederivesStaleApproverRole(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	approver, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	versionID := "55555555-5555-4555-8555-555555555555"
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: versionID,
		WorkflowDigest:    "sha256:" + strings.Repeat("ab", 32),
		ExecutionID:       "66666666-6666-4666-8666-666666666666",
		RequestedBy:       "77777777-7777-4777-8777-777777777777",
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if rec.ApproverRole != "approver" || rec.TargetID != "" || rec.PolicyResourceID != "" {
		t.Fatalf("seed = %+v", rec)
	}
	store.SetGateWaiting(func(string, string) (bool, bool) { return true, true })
	ver := wfstore.Version{ID: versionID, DefinitionYAML: adminGateDefinition, Digest: rec.WorkflowDigest}
	resolve := func(ctx context.Context, scope isolation.Scope, row Record) (policy.Requirement, error) {
		return ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, nil, row.WorkflowID, row.WorkflowVersionID, row.NodeID, now)
	}

	if _, err := store.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now, Roles: []string{"approver"}, Resolve: resolve,
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("approver decide = %v", err)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusPending || got.ApproverRole != "admin" || got.DecidedBy != "" || got.BindingFingerprint == rec.BindingFingerprint {
		t.Fatalf("after deny = %+v", got)
	}

	approved, err := store.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now, Roles: []string{"admin"}, Resolve: resolve,
	})
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != StatusApproved || approved.ApproverRole != "admin" || approved.BindingFingerprint == rec.BindingFingerprint {
		t.Fatalf("admin decide = %+v", approved)
	}

	lookup, err := store.Create(ctx, owner, CreateInput{
		WorkflowID:        rec.WorkflowID,
		WorkflowVersionID: "88888888-8888-4888-8888-888888888888",
		WorkflowDigest:    rec.WorkflowDigest,
		RequestedBy:       rec.RequestedBy,
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	failResolve := func(ctx context.Context, scope isolation.Scope, row Record) (policy.Requirement, error) {
		return ResolveGateRequirement(ctx, scope, staticVersion{err: wfstore.ErrNotFound}, nil, row.WorkflowID, row.WorkflowVersionID, row.NodeID, now)
	}
	if _, err := store.Decide(ctx, approver, lookup.ID, DecideInput{
		Decision: DecisionApproved, Now: now, Roles: []string{"admin"}, Resolve: failResolve,
	}); !errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("lookup decide = %v", err)
	}
	still, err := store.Get(ctx, owner, lookup.ID)
	if err != nil {
		t.Fatal(err)
	}
	if still.Status != StatusPending || still.DecidedBy != "" || still.ApproverRole != "approver" {
		t.Fatalf("lookup row = %+v", still)
	}
}

const pinnedGateDefinition = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: pinned-gate
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        policyId: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
        expiresIn: PT1H
  edges: []
`

type staticPins struct {
	pins []opsconfig.Pin
}

func (s staticPins) Resolve(context.Context, isolation.Scope, []opsconfig.Ref) ([]opsconfig.Pin, error) {
	return s.pins, nil
}

func TestMemoryDecidePersistsPolicyPinOnDeny(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	approver, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	versionID := "55555555-5555-4555-8555-555555555555"
	policyID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	policyVersion := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	policyDigest := "sha256:" + strings.Repeat("c", 64)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: versionID,
		WorkflowDigest:    "sha256:" + strings.Repeat("ab", 32),
		ExecutionID:       "66666666-6666-4666-8666-666666666666",
		RequestedBy:       "77777777-7777-4777-8777-777777777777",
		Requirement: policy.Requirement{
			NodeID: "gate", NodeName: "Gate", Operation: "flow.approval",
			ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	store.SetGateWaiting(func(string, string) (bool, bool) { return true, true })
	ver := wfstore.Version{ID: versionID, DefinitionYAML: pinnedGateDefinition, Digest: rec.WorkflowDigest}
	pins := staticPins{pins: []opsconfig.Pin{{
		Kind: opsconfig.KindPolicy, ResourceID: policyID, VersionID: policyVersion,
		VersionNumber: 4, Digest: policyDigest,
		Spec: map[string]any{"kind": "approval", "policy": map[string]any{}},
	}}}
	resolve := func(ctx context.Context, scope isolation.Scope, row Record) (policy.Requirement, error) {
		return ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, pins, row.WorkflowID, row.WorkflowVersionID, row.NodeID, now)
	}
	if _, err := store.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now, Roles: []string{"approver"}, Resolve: resolve,
	}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("approver decide = %v", err)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != StatusPending || got.DecidedBy != "" || got.ApproverRole != "admin" ||
		got.PolicyResourceID != policyID || got.PolicyVersionID != policyVersion ||
		got.PolicyDigest != policyDigest || got.PolicyRevision != 4 ||
		got.BindingFingerprint == rec.BindingFingerprint {
		t.Fatalf("after deny = %+v", got)
	}
	approved, err := store.Decide(ctx, approver, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now, Roles: []string{"admin"}, Resolve: resolve,
	})
	if err != nil {
		t.Fatal(err)
	}
	if approved.Status != StatusApproved || approved.ApproverRole != "admin" || approved.PolicyResourceID != policyID {
		t.Fatalf("admin decide = %+v", approved)
	}
}

func TestMemoryResyncCorrectsAndCloses(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	versionID := "55555555-5555-4555-8555-555555555555"
	ver := wfstore.Version{ID: versionID, DefinitionYAML: adminGateDefinition, Digest: "sha256:" + strings.Repeat("ab", 32)}
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: versionID, WorkflowDigest: ver.Digest,
		RequestedBy: "77777777-7777-4777-8777-777777777777",
		Requirement: policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	broken, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: rec.WorkflowID, WorkflowVersionID: "88888888-8888-4888-8888-888888888888", WorkflowDigest: ver.Digest,
		RequestedBy: rec.RequestedBy,
		Requirement: policy.Requirement{NodeID: "missing", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	versions := staticVersion{ver: ver}
	stats := store.ResyncPending(ctx, versions, nil, now)
	if stats.Corrected != 1 || stats.Closed != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.ApproverRole != "admin" || got.Status != StatusPending {
		t.Fatalf("corrected = %+v %v", got, err)
	}
	closed, err := store.Get(ctx, owner, broken.ID)
	if err != nil || closed.Status != StatusCanceled || closed.CloseReason != ReasonRequirementUnresolvable || closed.DecidedBy != "" {
		t.Fatalf("closed = %+v %v", closed, err)
	}
	again := store.ResyncPending(ctx, versions, nil, now)
	if again.Corrected != 0 || again.Closed != 0 {
		t.Fatalf("second = %+v", again)
	}
	still, err := store.Get(ctx, owner, rec.ID)
	if err != nil || !still.UpdatedAt.Equal(got.UpdatedAt) || still.BindingFingerprint != got.BindingFingerprint {
		t.Fatalf("second pass changed %+v", still)
	}
}
