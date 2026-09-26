package approval

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/jackc/pgx/v5/pgconn"
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
	events, err := store.Events(ctx, owner, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	from, to := correctedPair(t, events, "approverRole")
	if from != "approver" || to != "admin" {
		t.Fatalf("role correction = %s -> %s", from, to)
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
	err  error
}

func (s staticPins) Resolve(context.Context, isolation.Scope, []opsconfig.Ref) ([]opsconfig.Pin, error) {
	if s.err != nil {
		return nil, s.err
	}
	return s.pins, nil
}

const twoGateDefinition = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: two-gates
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
    - id: open
      type: flow.approval
      name: Open
      with:
        approverRole: approver
        expiresIn: PT1H
  edges:
    - from: gate.approved
      to: open.request
`

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
	events, err := store.Events(ctx, owner, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if from, to := correctedPair(t, events, "approverRole"); from != "approver" || to != "admin" {
		t.Fatalf("role correction = %s -> %s", from, to)
	}
	if from, to := correctedPair(t, events, "policyVersionId"); from != "" || to != policyVersion {
		t.Fatalf("policy correction = %s -> %s", from, to)
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
	events, err := store.Events(ctx, owner, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if from, to := correctedPair(t, events, "approverRole"); from != "approver" || to != "admin" {
		t.Fatalf("resync correction = %s -> %s", from, to)
	}
}

func TestResolveGateRequirementClassifiesTransient(t *testing.T) {
	ctx := context.Background()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	ver := wfstore.Version{ID: "55555555-5555-4555-8555-555555555555", DefinitionYAML: adminGateDefinition, Digest: "sha256:" + strings.Repeat("a", 64)}
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{err: context.DeadlineExceeded}, nil, "44444444-4444-4444-8444-444444444444", ver.ID, "gate", now); !errors.Is(err, ErrBindingTransient) {
		t.Fatalf("timeout = %v", err)
	}
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{err: wfstore.ErrNotFound}, nil, ver.WorkflowID, ver.ID, "gate", now); !errors.Is(err, ErrBindingUnresolved) || errors.Is(err, ErrBindingTransient) {
		t.Fatalf("not found = %v", err)
	}
}

func TestMemoryDecideDeniesWhenResolveMissing(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	decider, err := isolation.Authorize(owner.WorkspaceID(), "33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest: "sha256:" + strings.Repeat("a", 64),
		Requirement:    policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Decide(ctx, decider, rec.ID, DecideInput{Decision: DecisionApproved, Now: now, Roles: []string{"admin"}}); !errors.Is(err, ErrForbidden) {
		t.Fatalf("nil resolve = %v", err)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.DecidedBy != "" || got.ApproverRole != "approver" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestProjectRequirementKeepsNodeAndTarget(t *testing.T) {
	rec := Record{
		NodeID: "gate", NodeName: "Keep", Operation: "flow.approval",
		TargetKind: "cluster_target", TargetID: "66666666-6666-4666-8666-666666666666",
		TargetVersionID: "77777777-7777-4777-8777-777777777777", TargetDigest: "sha256:" + strings.Repeat("d", 64),
		WorkflowVersionID: "55555555-5555-4555-8555-555555555555", WorkflowDigest: "sha256:" + strings.Repeat("a", 64),
		ApproverRole: "approver",
	}
	req := policy.Requirement{
		NodeID: "other", NodeName: "Rewritten", Operation: "kubernetes.apply",
		TargetKind: "ssh_target", TargetID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		TargetVersionID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", TargetDigest: "sha256:" + strings.Repeat("e", 64),
		ApproverRole: "admin", PolicyResourceID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		PolicyVersionID: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", PolicyDigest: "sha256:" + strings.Repeat("f", 64), PolicyRevision: 3,
	}
	next, changed := ProjectRequirement(rec, "11111111-1111-4111-8111-111111111111", req)
	if !changed {
		t.Fatal("expected a role change")
	}
	if next.NodeID != rec.NodeID || next.NodeName != rec.NodeName || next.Operation != rec.Operation ||
		next.TargetKind != rec.TargetKind || next.TargetID != rec.TargetID ||
		next.TargetVersionID != rec.TargetVersionID || next.TargetDigest != rec.TargetDigest {
		t.Fatalf("rewrote stored fields: %+v", next)
	}
	if next.ApproverRole != "admin" || next.PolicyResourceID != req.PolicyResourceID || next.PolicyVersionID != req.PolicyVersionID || next.PolicyRevision != 3 {
		t.Fatalf("pin = %+v", next)
	}
}

func TestMemoryDecideTransientRecordsNothing(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	decider, err := isolation.Authorize(owner.WorkspaceID(), "33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest: "sha256:" + strings.Repeat("a", 64),
		Requirement:    policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Decide(ctx, decider, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now, Roles: []string{"admin"},
		Resolve: func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
			return policy.Requirement{}, fmt.Errorf("%w: deadline", ErrBindingTransient)
		},
	}); !errors.Is(err, ErrBindingTransient) {
		t.Fatalf("decide = %v", err)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.DecidedBy != "" || got.ApproverRole != "approver" || got.BindingFingerprint != rec.BindingFingerprint {
		t.Fatalf("row = %+v %v", got, err)
	}
	events, err := store.Events(ctx, owner, rec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, ev := range events {
		if ev.EventType == EventCorrected || ev.EventType == EventApproved || ev.EventType == EventCanceled {
			t.Fatalf("event = %+v", ev)
		}
	}
}

func TestMemoryResyncSkipsTransient(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest: "sha256:" + strings.Repeat("a", 64), ExecutionID: "66666666-6666-4666-8666-666666666666",
		Requirement: policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	store.SetUnresolvableRun(func(context.Context, isolation.Scope, string, string, string, time.Time) error {
		t.Fatal("transient resync settled the run")
		return nil
	})
	stats := store.ResyncPending(ctx, staticVersion{err: context.DeadlineExceeded}, nil, now)
	if stats.Closed != 0 || stats.Corrected != 0 || stats.Skipped != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" || got.ApproverRole != "approver" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestMemoryResyncRebuildsFromRunPin(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	versionID := "55555555-5555-4555-8555-555555555555"
	policyID := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	pinned := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	current := "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	digest := "sha256:" + strings.Repeat("ab", 32)
	pinDigest := "sha256:" + strings.Repeat("d", 64)
	execID := "66666666-6666-4666-8666-666666666666"
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: versionID, WorkflowDigest: digest,
		ExecutionID: execID,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	plain, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: versionID, WorkflowDigest: digest,
		ExecutionID: execID,
		Requirement: policy.Requirement{
			NodeID: "open", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	RememberRun(store, execID, versionID, digest, []opsconfig.Pin{{
		Kind: opsconfig.KindPolicy, ResourceID: policyID, VersionID: pinned,
		VersionNumber: 2, Digest: pinDigest,
	}})
	ver := wfstore.Version{ID: versionID, DefinitionYAML: twoGateDefinition, Digest: digest}
	stats := store.ResyncPending(ctx, staticVersion{ver: ver}, staticPins{pins: []opsconfig.Pin{{
		Kind: opsconfig.KindPolicy, ResourceID: policyID, VersionID: current,
		VersionNumber: 9, Digest: "sha256:" + strings.Repeat("e", 64),
		Spec: map[string]any{"kind": "approval", "policy": map[string]any{}},
	}}}, now)
	if stats.Closed != 0 || stats.Corrected != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.ApproverRole != "admin" || got.PolicyVersionID != pinned || got.PolicyDigest != pinDigest {
		t.Fatalf("pinned row = %+v %v", got, err)
	}
	open, err := store.Get(ctx, owner, plain.ID)
	if err != nil || open.Status != StatusPending || open.PolicyVersionID != "" || open.PolicyResourceID != "" {
		t.Fatalf("open row = %+v %v", open, err)
	}
}

func TestResolveTreatsPrivilegeAsTransient(t *testing.T) {
	ctx := context.Background()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	denied := errors.Join(wfstore.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{err: denied}, nil, "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "gate", time.Now().UTC()); !errors.Is(err, ErrBindingTransient) || errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("version = %v", err)
	}
	ver := wfstore.Version{ID: "55555555-5555-4555-8555-555555555555", DefinitionYAML: pinnedGateDefinition, Digest: "sha256:" + strings.Repeat("ab", 32)}
	pinDenied := errors.Join(opsconfig.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
	if _, err := ResolveGateRequirement(ctx, scope, staticVersion{ver: ver}, staticPins{err: pinDenied}, "44444444-4444-4444-8444-444444444444", ver.ID, "gate", time.Now().UTC()); !errors.Is(err, ErrBindingTransient) || errors.Is(err, ErrBindingUnresolved) {
		t.Fatalf("policy = %v", err)
	}
}

func TestMemoryResyncSkipsPrivilegeFailure(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest: "sha256:" + strings.Repeat("a", 64),
		Requirement:    policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	store.SetUnresolvableRun(func(context.Context, isolation.Scope, string, string, string, time.Time) error {
		t.Fatal("privilege failure settled the run")
		return nil
	})
	denied := errors.Join(wfstore.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
	stats := store.ResyncPending(ctx, staticVersion{err: denied}, nil, now)
	if stats.Closed != 0 || stats.Corrected != 0 || stats.Skipped != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestMemoryResyncSkipsPrivilegeOnPolicy(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	versionID := "55555555-5555-4555-8555-555555555555"
	digest := "sha256:" + strings.Repeat("ab", 32)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: versionID, WorkflowDigest: digest,
		Requirement: policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)},
	})
	if err != nil {
		t.Fatal(err)
	}
	store.SetUnresolvableRun(func(context.Context, isolation.Scope, string, string, string, time.Time) error {
		t.Fatal("privilege failure settled the run")
		return nil
	})
	ver := wfstore.Version{ID: versionID, DefinitionYAML: pinnedGateDefinition, Digest: digest}
	denied := errors.Join(opsconfig.ErrNotFound, &pgconn.PgError{Code: "42501", Message: "permission denied"})
	stats := store.ResyncPending(ctx, staticVersion{ver: ver}, staticPins{err: denied}, now)
	if stats.Closed != 0 || stats.Corrected != 0 || stats.Skipped != 1 {
		t.Fatalf("stats = %+v", stats)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusPending || got.CloseReason != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestMemoryExpiredStatusReturnsClosed(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	owner, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	decider, err := isolation.Authorize(owner.WorkspaceID(), "33333333-3333-4333-8333-333333333333")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 26, 1, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, owner, CreateInput{
		WorkflowID: "44444444-4444-4444-8444-444444444444", WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest: "sha256:" + strings.Repeat("a", 64),
		Requirement:    policy.Requirement{NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Minute)},
	})
	if err != nil {
		t.Fatal(err)
	}
	refreshed, err := store.Refresh(ctx, owner, rec.ID, CurrentHeads{}, now.Add(time.Hour))
	if err != nil || refreshed.Status != StatusExpired {
		t.Fatalf("refresh = %+v %v", refreshed, err)
	}
	if _, err := store.Decide(ctx, decider, rec.ID, DecideInput{
		Decision: DecisionApproved, Now: now.Add(time.Hour), Roles: []string{"admin"},
		Resolve: func(context.Context, isolation.Scope, Record) (policy.Requirement, error) {
			return StoredRequirement(rec), nil
		},
	}); !errors.Is(err, ErrClosed) {
		t.Fatalf("decide = %v", err)
	}
	got, err := store.Get(ctx, owner, rec.ID)
	if err != nil || got.Status != StatusExpired || got.DecidedBy != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func correctedPair(t *testing.T, events []Event, key string) (string, string) {
	t.Helper()
	for _, ev := range events {
		if ev.EventType != EventCorrected {
			continue
		}
		raw, ok := ev.Details[key].(map[string]any)
		if !ok {
			t.Fatalf("corrected %s = %+v", key, ev.Details)
		}
		return fmt.Sprint(raw["from"]), fmt.Sprint(raw["to"])
	}
	t.Fatal("missing corrected event")
	return "", ""
}
