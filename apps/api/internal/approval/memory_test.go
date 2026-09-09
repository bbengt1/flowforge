package approval

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/policy"
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
