package approval

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestMemoryCreateDecideAndInvalidate(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	other, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	in := CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest:    "sha256:" + strings.Repeat("a", 64),
		Requirement: policy.Requirement{
			NodeID: "restart", Operation: "kubernetes.apply",
			TargetID: "66666666-6666-4666-8666-666666666666", TargetVersionID: "77777777-7777-4777-8777-777777777777",
			PolicyResourceID: "88888888-8888-4888-8888-888888888888", PolicyVersionID: "99999999-9999-4999-8999-999999999999",
			PolicyDigest: "sha256:" + strings.Repeat("b", 64), PolicyRevision: 1,
			ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	}
	rec, err := store.Create(ctx, scope, in)
	if err != nil {
		t.Fatal(err)
	}
	again, err := store.Create(ctx, scope, in)
	if err != nil || again.ID != rec.ID {
		t.Fatalf("idempotent create: %+v %v", again, err)
	}
	if _, err := store.Get(ctx, other, rec.ID); err != ErrNotFound {
		t.Fatalf("cross-workspace get: %v", err)
	}

	decider, err := isolation.Authorize(scope.WorkspaceID(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	approved, err := store.Decide(ctx, decider, rec.ID, DecideInput{Decision: "approve", Now: now.Add(time.Minute)})
	if err != nil || approved.Status != StatusApproved {
		t.Fatalf("decide: %+v %v", approved, err)
	}

	n, err := store.InvalidateMatching(ctx, scope, InvalidateInput{ResourceID: in.Requirement.PolicyResourceID, Reason: "policy-changed"})
	if err != nil || n != 1 {
		t.Fatalf("invalidate %d %v", n, err)
	}
	got, err := store.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusInvalidated {
		t.Fatalf("after invalidate: %+v %v", got, err)
	}
}

func TestMemorySelfApprovalAndExpiry(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, scope, CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest:    "sha256:" + strings.Repeat("a", 64),
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(5 * time.Minute),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Decide(ctx, scope, rec.ID, DecideInput{Decision: "approved", Now: now}); err != ErrSelfApproval {
		t.Fatalf("self approval: %v", err)
	}
	decider, err := isolation.Authorize(scope.WorkspaceID(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Decide(ctx, decider, rec.ID, DecideInput{Decision: "approved", Now: now.Add(10 * time.Minute)})
	if err != ErrExpired || got.Status != StatusExpired {
		t.Fatalf("expired decide: %+v %v", got, err)
	}
}

func TestFreshnessInvalidatesChangedPolicy(t *testing.T) {
	now := time.Now().UTC()
	rec := Record{
		Status: StatusApproved, ExpiresAt: now.Add(time.Hour),
		PolicyVersionID: "11111111-1111-4111-8111-111111111111",
		TargetVersionID: "22222222-2222-4222-8222-222222222222",
		WorkflowDigest:  "sha256:" + strings.Repeat("a", 64),
	}
	status, reason := Freshness(rec, CurrentHeads{
		PolicyLatestVersionID: "33333333-3333-4333-8333-333333333333",
		TargetLatestVersionID: rec.TargetVersionID,
		WorkflowDigest:        rec.WorkflowDigest,
	}, now)
	if status != StatusInvalidated || reason == "" {
		t.Fatalf("status=%s reason=%s", status, reason)
	}
}

func TestMemoryPendingListHidesExpired(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	base := CreateInput{
		WorkflowID:        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		WorkflowVersionID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		WorkflowDigest:    "sha256:" + strings.Repeat("ab", 32),
	}
	liveIn := base
	liveIn.Requirement = policy.Requirement{NodeID: "live", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour)}
	live, err := store.Create(ctx, scope, liveIn)
	if err != nil {
		t.Fatal(err)
	}
	staleIn := base
	staleIn.Requirement = policy.Requirement{NodeID: "stale", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(-time.Minute)}
	stale, err := store.Create(ctx, scope, staleIn)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := store.List(ctx, scope, Filter{Status: StatusPending})
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || pending[0].ID != live.ID {
		t.Fatalf("pending = %+v", pending)
	}
	all, err := store.List(ctx, scope, Filter{})
	if err != nil {
		t.Fatal(err)
	}
	saw := false
	for _, rec := range all {
		if rec.ID == stale.ID {
			saw = true
		}
	}
	if !saw {
		t.Fatal("unfiltered list dropped the expired row")
	}
}

func TestMemoryDecideClosedGate(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	store.SetGateWaiting(func(executionID, nodeID string) (bool, bool) {
		return true, false
	})
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	rec, err := store.Create(ctx, scope, CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest:    "sha256:" + strings.Repeat("a", 64),
		ExecutionID:       "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	decider, err := isolation.Authorize(scope.WorkspaceID(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Decide(ctx, decider, rec.ID, DecideInput{Decision: "approved", Now: now}); err != ErrClosed {
		t.Fatalf("closed gate = %v", err)
	}
	got, err := store.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusExpired || got.DecidedBy != "" {
		t.Fatalf("row = %+v %v", got, err)
	}
}

func TestMemoryCreateSupersedesWrongRole(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	base := CreateInput{
		WorkflowID:        "44444444-4444-4444-8444-444444444444",
		WorkflowVersionID: "55555555-5555-4555-8555-555555555555",
		WorkflowDigest:    "sha256:" + strings.Repeat("a", 64),
		ExecutionID:       "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
	}
	wrongIn := base
	wrongIn.Requirement = policy.Requirement{
		NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver", ExpiresAt: now.Add(time.Hour),
	}
	wrong, err := store.Create(ctx, scope, wrongIn)
	if err != nil {
		t.Fatal(err)
	}
	rightIn := base
	rightIn.Requirement = policy.Requirement{
		NodeID: "gate", Operation: "flow.approval", ApproverRole: "admin", ExpiresAt: now.Add(time.Hour),
	}
	right, err := store.Create(ctx, scope, rightIn)
	if err != nil {
		t.Fatal(err)
	}
	if right.ID == wrong.ID || right.ApproverRole != "admin" || right.Status != StatusPending {
		t.Fatalf("replacement = %+v", right)
	}
	got, err := store.Get(ctx, scope, wrong.ID)
	if err != nil || got.Status != StatusInvalidated {
		t.Fatalf("old row = %+v %v", got, err)
	}
	decider, err := isolation.Authorize(scope.WorkspaceID(), "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Decide(ctx, decider, wrong.ID, DecideInput{Decision: "approved", Now: now}); err == nil {
		t.Fatal("invalidated row was decided")
	}
	if HasApproverRole([]string{"approver"}, right.ApproverRole) {
		t.Fatal("approver must not satisfy admin")
	}
}

func TestMemoryDeleteClosedRunsCloseApprovals(t *testing.T) {
	ctx := context.Background()
	store := wfstore.NewMemory()
	approvals := NewMemory()
	scope, err := isolation.AuthorizeTenancy(
		"11111111-1111-4111-8111-111111111111",
		"22222222-2222-4222-8222-222222222222",
		"33333333-3333-4333-8333-333333333333",
		"bench",
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, errs := workflow.ParseAndNormalize([]byte(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: close-approvals
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
  edges: []
`))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{
		Slug:           "close-approvals",
		NormalizedYAML: parsed.NormalizedYAML,
		Digest:         parsed.Digest,
		Summary:        parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := store.ListJobs(ctx, scope, exec.ID)
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %+v %v", jobs, err)
	}
	if _, err := store.WaitJob(ctx, scope, time.Now().UTC(), wfstore.WaitJobInput{
		JobID: jobs[0].ID, AvailableAt: time.Now().UTC().Add(time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	rec, err := approvals.Create(ctx, scope, CreateInput{
		WorkflowID:        wf.ID,
		WorkflowVersionID: ver.ID,
		WorkflowDigest:    ver.Digest,
		ExecutionID:       exec.ID,
		Requirement: policy.Requirement{
			NodeID: "gate", Operation: "flow.approval", ApproverRole: "approver",
			ExpiresAt: time.Now().UTC().Add(time.Hour),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := store.Delete(ctx, scope, wf.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.ClosedRuns) != 1 || result.ClosedRuns[0] != exec.ID {
		t.Fatalf("closed = %v", result.ClosedRuns)
	}
	for _, executionID := range result.ClosedRuns {
		if err := approvals.ClosePendingForExecution(ctx, scope, executionID, ReasonWorkflowDeleted, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
	}
	got, err := approvals.Get(ctx, scope, rec.ID)
	if err != nil || got.Status != StatusCanceled || got.CloseReason != ReasonWorkflowDeleted || got.DecidedBy != "" {
		t.Fatalf("approval = %+v %v", got, err)
	}
}

func TestHasApproverRole(t *testing.T) {
	if !HasApproverRole([]string{"approver"}, "approver") {
		t.Fatal("approver")
	}
	if !HasApproverRole([]string{"admin"}, "publisher") {
		t.Fatal("admin")
	}
	if HasApproverRole([]string{"operator"}, "approver") {
		t.Fatal("operator must not decide")
	}
}
