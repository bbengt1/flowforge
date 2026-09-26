package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestApprovalRetryLimitUsesStoredExpiresIn(t *testing.T) {
	queued := time.Date(2026, 9, 26, 3, 0, 0, 0, time.UTC)
	limit, ok := ApprovalRetryLimit(queued, time.Time{}, map[string]any{"expiresIn": "PT1H"})
	if !ok || !limit.Equal(queued.Add(time.Hour)) {
		t.Fatalf("limit = %s ok=%v", limit, ok)
	}
	limit, ok = ApprovalRetryLimit(queued, time.Time{}, map[string]any{})
	if !ok || !limit.Equal(queued.Add(time.Hour)) {
		t.Fatalf("missing expiresIn = %s ok=%v", limit, ok)
	}
	limit, ok = ApprovalRetryLimit(queued, time.Time{}, map[string]any{"expiresIn": "later"})
	if !ok || !limit.Equal(queued.Add(time.Hour)) {
		t.Fatalf("unparseable expiresIn = %s ok=%v", limit, ok)
	}
	limit, ok = ApprovalRetryLimit(queued, time.Time{}, map[string]any{"expiresIn": "P8D"})
	if !ok || !limit.Equal(queued.Add(7*24*time.Hour)) {
		t.Fatalf("capped = %s ok=%v", limit, ok)
	}
	if _, ok := ApprovalRetryLimit(time.Time{}, time.Time{}, map[string]any{"expiresIn": "PT1H"}); ok {
		t.Fatal("zero anchor invented a limit")
	}
	parked := queued.Add(3 * time.Hour)
	limit, ok = ApprovalRetryLimit(queued, parked, map[string]any{"expiresIn": "PT1H"})
	if !ok || !limit.Equal(parked) {
		t.Fatalf("pending expiry = %s ok=%v", limit, ok)
	}
	limit, ok = ApprovalRetryLimit(time.Time{}, parked, map[string]any{"expiresIn": "PT1H"})
	if !ok || !limit.Equal(parked) {
		t.Fatalf("pending expiry without created_at = %s ok=%v", limit, ok)
	}
}

func TestApprovalRetryWaitIsFlat(t *testing.T) {
	if d := approvalRetryWait(0); d != 30*time.Second {
		t.Fatalf("low = %s", d)
	}
	if d := approvalRetryWait(1); d != 35*time.Second {
		t.Fatalf("high = %s", d)
	}
	mid := approvalRetryWait(0.5)
	if mid < 32*time.Second+500*time.Millisecond-time.Millisecond || mid > 32*time.Second+500*time.Millisecond+time.Millisecond {
		t.Fatalf("mid = %s", mid)
	}
}

func TestMemoryApprovalTransientBackoff(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	norm := mustNormalize(t, expiredDownstreamYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	attempt := claimed.Job.Attempt
	plain, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
	})
	if err != nil {
		t.Fatal(err)
	}
	if plain.Job.Status != JobQueued || plain.Job.Attempt != attempt || plain.Job.AvailableAt.After(now) {
		t.Fatalf("plain release = %+v", plain.Job)
	}
	claimed, err = store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	clock := now
	for i := 0; i < 2; i++ {
		released, err := store.ReleaseJob(ctx, scope, clock, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Job.Status != JobQueued || released.Job.Attempt != attempt {
			t.Fatalf("release %d = %+v", i, released.Job)
		}
		assertFlatDelay(t, released.Job.AvailableAt.Sub(clock))
		early := clock.Add(30*time.Second - time.Millisecond)
		if _, err := store.ClaimJob(ctx, scope, early, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("claimed before 30s on retry %d: %v", i, err)
		}
		clock = clock.Add(35 * time.Second)
		claimed, err = store.ClaimJob(ctx, scope, clock, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || claimed.Job.Attempt != attempt {
			t.Fatalf("reclaim %d = %+v %v", i, claimed.Job, err)
		}
	}
	// The gate deadline is PT1H. A sweep before that must not take expired.
	if _, err := store.RecoverExpiredLeases(ctx, scope, now.Add(50*time.Minute)); err != nil {
		t.Fatal(err)
	}
	job := gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobQueued || job.Attempt != attempt {
		t.Fatalf("before deadline = %+v", job)
	}
	assertNotExpired(t, ctx, store, scope, exec.ID)
}

func TestMemoryApprovalRecoveryBackoff(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	norm := mustNormalize(t, expiredDownstreamYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	attempt := claimed.Job.Attempt
	recoverAt := now.Add(2 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobQueued || job.Attempt != attempt {
		t.Fatalf("requeue = %+v", job)
	}
	assertFlatDelay(t, job.AvailableAt.Sub(recoverAt))
	if _, err := store.ClaimJob(ctx, scope, recoverAt.Add(30*time.Second-time.Millisecond), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
		t.Fatalf("claimed before 30s: %v", err)
	}
	claimed, err = store.ClaimJob(ctx, scope, recoverAt.Add(35*time.Second), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Job.Attempt != attempt {
		t.Fatalf("reclaim = %+v %v", claimed.Job, err)
	}
	beforeDeadline := now.Add(50 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, beforeDeadline); err != nil {
		t.Fatal(err)
	}
	job = gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobQueued || job.Attempt != attempt {
		t.Fatalf("before deadline = %+v", job)
	}
	assertFlatDelay(t, job.AvailableAt.Sub(beforeDeadline))
	assertNotExpired(t, ctx, store, scope, exec.ID)
}

func TestMemoryApprovalTransientPastDeadlineFails(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	norm := mustNormalize(t, expiredDownstreamYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	attempt := claimed.Job.Attempt
	recoverAt := claimed.Job.CreatedAt.Add(2 * time.Hour)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobFailed || job.Attempt != attempt {
		t.Fatalf("past deadline = %+v", job)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" {
			if step.Status != ExecutionFailed || step.Error["code"] != ReasonRequirementUnresolvable {
				t.Fatalf("gate = %+v", step)
			}
		}
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("%s took expired", step.NodeID)
		}
		if step.NodeID == "late" && step.Status == ExecutionSucceeded {
			t.Fatal("late ran")
		}
	}
	got, err := store.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil || got.Status != ExecutionFailed {
		t.Fatalf("run = %+v %v", got, err)
	}
}

func TestMemoryDeadlineAnchorSurvivesRequeueRecoveryAndReclaim(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	norm := mustNormalize(t, expiredDownstreamYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	anchor, stepAnchor := claimed.Job.CreatedAt, claimed.Step.CreatedAt
	released, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
		ApprovalTransientRetry: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	assertAnchor(t, anchor, stepAnchor, released.Job.CreatedAt, released.Step.CreatedAt)
	claimed, err = store.ClaimJob(ctx, scope, now.Add(35*time.Second), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	assertAnchor(t, anchor, stepAnchor, claimed.Job.CreatedAt, claimed.Step.CreatedAt)
	recoverAt := now.Add(2 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := gateJob(t, ctx, store, scope, exec.ID)
	stepAt := gateStepCreated(t, ctx, store, scope, exec.ID)
	assertAnchor(t, anchor, stepAnchor, job.CreatedAt, stepAt)
	claimed, err = store.ClaimJob(ctx, scope, recoverAt.Add(35*time.Second), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	assertAnchor(t, anchor, stepAnchor, claimed.Job.CreatedAt, claimed.Step.CreatedAt)
}

func TestMemoryPendingPastDeadlineFailsUnresolvable(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	store.SetApprovalPending(func(string, string) (time.Time, bool) { return time.Time{}, true })
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	norm := mustNormalize(t, expiredDownstreamYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	recoverAt := claimed.Job.CreatedAt.Add(2 * time.Hour)
	if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
		t.Fatal(err)
	}
	job := gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobFailed || job.Attempt != claimed.Job.Attempt {
		t.Fatalf("past deadline = %+v", job)
	}
	assertNotExpired(t, ctx, store, scope, exec.ID)
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" && (step.Status != ExecutionFailed || step.Error["code"] != ReasonRequirementUnresolvable) {
			t.Fatalf("gate = %+v", step)
		}
	}
}

func TestMemoryWaitingGateStillExpires(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	store.SetApprovalPending(func(string, string) (time.Time, bool) { return time.Time{}, true })
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Minute)
	norm := mustNormalize(t, expiredDownstreamYAML)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	limit, ok := ApprovalRetryLimit(claimed.Job.CreatedAt, time.Time{}, claimed.Step.Input)
	if !ok {
		t.Fatal("missing limit")
	}
	if _, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: claimed.Job.ID, AvailableAt: limit}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecoverExpiredLeases(ctx, scope, limit); err != nil {
		t.Fatal(err)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID != "gate" {
			continue
		}
		if step.Status != ExecutionSucceeded || step.Output["port"] != "expired" {
			t.Fatalf("waiting gate = %+v", step)
		}
		if step.Error["code"] == ReasonRequirementUnresolvable {
			t.Fatalf("waiting gate failed unresolvable: %+v", step)
		}
	}
}

func TestMemoryRetryLimitFollowsPendingExpiry(t *testing.T) {
	ctx := context.Background()
	t.Run("follows expires_at", func(t *testing.T) {
		store, scope, exec, claimed := claimMemoryGate(t, ctx, expiredDownstreamYAML, time.Minute)
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(3 * time.Hour)
		var closed int
		store.SetApprovalPending(func(string, string) (time.Time, bool) { return expires, true })
		store.SetApprovalUnresolvable(func(string, string, time.Time) { closed++ })
		recoverAt := anchor.Add(2 * time.Hour)
		if _, err := store.RecoverExpiredLeases(ctx, scope, recoverAt); err != nil {
			t.Fatal(err)
		}
		job := gateJob(t, ctx, store, scope, exec.ID)
		if job.Status != JobWaiting || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("inside approval deadline = %+v", job)
		}
		if closed != 0 {
			t.Fatalf("closed %d approvals", closed)
		}
		assertNotExpired(t, ctx, store, scope, exec.ID)
	})
	t.Run("falls back to created_at", func(t *testing.T) {
		store, scope, exec, claimed := claimMemoryGate(t, ctx, expiredDownstreamYAML, time.Minute)
		anchor := claimed.Job.CreatedAt
		var closed int
		store.SetApprovalUnresolvable(func(string, string, time.Time) { closed++ })
		if _, err := store.RecoverExpiredLeases(ctx, scope, anchor.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		job := gateJob(t, ctx, store, scope, exec.ID)
		if job.Status != JobFailed || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("created_at limit = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)
		if closed != 0 {
			t.Fatalf("closed %d approvals", closed)
		}
	})
	t.Run("closes pending at the limit", func(t *testing.T) {
		store, scope, exec, claimed := claimMemoryGate(t, ctx, expiredDownstreamYAML, time.Minute)
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(3 * time.Hour)
		var closedNode string
		store.SetApprovalPending(func(string, string) (time.Time, bool) { return expires, true })
		store.SetApprovalUnresolvable(func(_, nodeID string, _ time.Time) { closedNode = nodeID })
		if _, err := store.RecoverExpiredLeases(ctx, scope, expires); err != nil {
			t.Fatal(err)
		}
		job := gateJob(t, ctx, store, scope, exec.ID)
		if job.Status != JobFailed || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("at expires_at = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)
		if closedNode != "gate" {
			t.Fatalf("closed node = %q", closedNode)
		}
	})
}

func TestMemoryReleaseFollowsPendingExpiry(t *testing.T) {
	ctx := context.Background()
	t.Run("follows expires_at", func(t *testing.T) {
		store, scope, exec, claimed := claimMemoryGate(t, ctx, shortExpiryGateYAML, 5*time.Minute)
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(4 * time.Minute)
		var closed int
		store.SetApprovalPending(func(string, string) (time.Time, bool) { return expires, true })
		store.SetApprovalUnresolvable(func(string, string, time.Time) { closed++ })
		released, err := store.ReleaseJob(ctx, scope, anchor.Add(30*time.Second), JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Job.Status != JobQueued || !released.Job.CreatedAt.Equal(anchor) || closed != 0 {
			t.Fatalf("before expires_at = %+v closed=%d", released.Job, closed)
		}
		assertNotExpired(t, ctx, store, scope, exec.ID)
	})
	t.Run("falls back to created_at", func(t *testing.T) {
		store, scope, _, claimed := claimMemoryGate(t, ctx, shortExpiryGateYAML, 5*time.Minute)
		anchor := claimed.Job.CreatedAt
		released, err := store.ReleaseJob(ctx, scope, anchor.Add(30*time.Second), JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Job.Status != JobFailed || released.Step.Error["code"] != ReasonRequirementUnresolvable || !released.Job.CreatedAt.Equal(anchor) {
			t.Fatalf("created_at limit = %+v %+v", released.Job, released.Step.Error)
		}
	})
	t.Run("closes pending at the limit", func(t *testing.T) {
		store, scope, _, claimed := claimMemoryGate(t, ctx, shortExpiryGateYAML, 5*time.Minute)
		anchor := claimed.Job.CreatedAt
		expires := anchor.Add(4 * time.Minute)
		var closedNode string
		store.SetApprovalPending(func(string, string) (time.Time, bool) { return expires, true })
		store.SetApprovalUnresolvable(func(_, nodeID string, _ time.Time) { closedNode = nodeID })
		released, err := store.ReleaseJob(ctx, scope, anchor.Add(30*time.Second), JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil || released.Job.Status != JobQueued {
			t.Fatalf("early release = %+v %v", released.Job, err)
		}
		claimed, err = store.ClaimJob(ctx, scope, expires, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		released, err = store.ReleaseJob(ctx, scope, expires, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Job.Status != JobFailed || released.Step.Error["code"] != ReasonRequirementUnresolvable || !released.Job.CreatedAt.Equal(anchor) {
			t.Fatalf("at expires_at = %+v %+v", released.Job, released.Step.Error)
		}
		if closedNode != "gate" {
			t.Fatalf("closed node = %q", closedNode)
		}
	})
}

func claimMemoryGate(t *testing.T, ctx context.Context, src string, lease time.Duration) (*Memory, isolation.Scope, Execution, DispatchResult) {
	t.Helper()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	norm := mustNormalize(t, src)
	wf, _, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: norm.NormalizedYAML, Digest: norm.Digest, Summary: norm.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: 1})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC().Add(time.Minute), ClaimInput{WorkerID: "edge-worker", Lease: lease})
	if err != nil || claimed.Step.NodeID != "gate" {
		t.Fatalf("claim = %s %v", claimed.Step.NodeID, err)
	}
	return store, scope, exec, claimed
}

func assertUnresolvableGate(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, executionID string) {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" && (step.Status != ExecutionFailed || step.Error["code"] != ReasonRequirementUnresolvable) {
			t.Fatalf("gate = %+v", step)
		}
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("%s took expired", step.NodeID)
		}
	}
}

const shortExpiryGateYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: short-expiry-gate
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
        expiresIn: PT1S
    - id: late
      type: flow.stop
      name: Late
      with:
        status: success
  edges:
    - from: gate.expired
      to: late.input
`

func assertAnchor(t *testing.T, jobAt, stepAt, gotJob, gotStep time.Time) {
	t.Helper()
	if !gotJob.Equal(jobAt) || !gotStep.Equal(stepAt) {
		t.Fatalf("anchor moved job %s -> %s step %s -> %s", jobAt, gotJob, stepAt, gotStep)
	}
}

func gateStepCreated(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, executionID string) time.Time {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == "gate" {
			return step.CreatedAt
		}
	}
	t.Fatal("missing gate step")
	return time.Time{}
}

func assertFlatDelay(t *testing.T, delay time.Duration) {
	t.Helper()
	if delay < 30*time.Second || delay > 35*time.Second+time.Millisecond {
		t.Fatalf("delay = %s want 30s..35s", delay)
	}
}

func gateJob(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, executionID string) ExecutionJob {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var stepID string
	for _, step := range steps {
		if step.NodeID == "gate" {
			stepID = step.ID
		}
	}
	for _, job := range jobs {
		if job.ExecutionStepID == stepID {
			return job
		}
	}
	t.Fatal("missing gate job")
	return ExecutionJob{}
}

func assertNotExpired(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, executionID string) {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("%s took expired", step.NodeID)
		}
		if step.NodeID == "late" && step.Status == ExecutionSucceeded {
			t.Fatalf("late ran")
		}
	}
}
