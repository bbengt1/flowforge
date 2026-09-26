package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
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
		t.Fatalf("pending expiry without a gate-ready time = %s ok=%v", limit, ok)
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
	if claimed.Execution.StartedAt == nil || !claimed.Execution.StartedAt.Equal(now) {
		t.Fatalf("run start moved: %v", claimed.Execution.StartedAt)
	}
	if _, err := store.RecoverExpiredLeases(ctx, scope, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	job = gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobFailed || !job.CreatedAt.Equal(anchor) {
		t.Fatalf("limit after restart = %+v", job)
	}
	assertUnresolvableGate(t, ctx, store, scope, exec.ID)
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
	d, _ := workflow.ApprovalWaitDuration("PT1H")
	limit := now.Add(d)
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
	t.Run("falls back to run start", func(t *testing.T) {
		store, scope, exec, claimed := claimMemoryGate(t, ctx, expiredDownstreamYAML, time.Minute)
		anchor := claimed.Job.CreatedAt
		if claimed.Execution.StartedAt == nil {
			t.Fatal("root gate has no run start")
		}
		ready := claimed.Execution.StartedAt.UTC()
		var closed int
		store.SetApprovalUnresolvable(func(string, string, time.Time) { closed++ })
		if _, err := store.RecoverExpiredLeases(ctx, scope, ready.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		job := gateJob(t, ctx, store, scope, exec.ID)
		if job.Status != JobFailed || !job.CreatedAt.Equal(anchor) {
			t.Fatalf("run start limit = %+v", job)
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
	t.Run("falls back to run start", func(t *testing.T) {
		store, scope, _, claimed := claimMemoryGate(t, ctx, shortExpiryGateYAML, 5*time.Minute)
		anchor := claimed.Job.CreatedAt
		if claimed.Execution.StartedAt == nil {
			t.Fatal("root gate has no run start")
		}
		ready := claimed.Execution.StartedAt.UTC()
		released, err := store.ReleaseJob(ctx, scope, ready.Add(time.Second), JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Job.Status != JobFailed || released.Step.Error["code"] != ReasonRequirementUnresolvable || !released.Job.CreatedAt.Equal(anchor) {
			t.Fatalf("run start limit = %+v %+v", released.Job, released.Step.Error)
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

func TestMemoryRetryLimitFollowsGateReadyTime(t *testing.T) {
	ctx := context.Background()
	t.Run("upstream finished_at", func(t *testing.T) {
		store, scope, exec := startMemoryRun(t, ctx, delayThenGateYAML("PT1H"))
		created := nodeJob(t, ctx, store, scope, exec.ID, "gate").CreatedAt
		finish := created.Add(2 * time.Hour)
		completeMemoryNode(t, ctx, store, scope, "pause", finish)
		claimMemoryNode(t, ctx, store, scope, "gate", finish, time.Minute)
		// created_at plus PT1H is already behind this claim. The limit is the
		// upstream finished_at, so the claim is still inside the window.
		if _, err := store.RecoverExpiredLeases(ctx, scope, finish.Add(2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		job := nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobQueued || !job.CreatedAt.Equal(created) {
			t.Fatalf("inside upstream window = %+v", job)
		}
		assertNotExpired(t, ctx, store, scope, exec.ID)
		reclaimed := claimMemoryNode(t, ctx, store, scope, "gate", finish.Add(time.Hour-2*time.Minute), time.Minute)
		if _, err := store.RecoverExpiredLeases(ctx, scope, finish.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		job = nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobFailed || job.Attempt != reclaimed.Job.Attempt || !job.CreatedAt.Equal(created) {
			t.Fatalf("at upstream limit = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)
	})
	t.Run("root run start", func(t *testing.T) {
		store, scope, exec := startMemoryRun(t, ctx, expiredDownstreamYAML)
		created := nodeJob(t, ctx, store, scope, exec.ID, "gate").CreatedAt
		// The run insert is the anchor. A claim does not move it, and two
		// hours later is already past PT1H.
		late := claimMemoryNode(t, ctx, store, scope, "gate", created.Add(2*time.Hour), time.Minute)
		if _, err := store.RecoverExpiredLeases(ctx, scope, created.Add(2*time.Hour+2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		job := nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobFailed || job.Attempt != late.Job.Attempt || !job.CreatedAt.Equal(created) {
			t.Fatalf("late claim stays on run start = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)

		store, scope, exec = startMemoryRun(t, ctx, expiredDownstreamYAML)
		created = nodeJob(t, ctx, store, scope, exec.ID, "gate").CreatedAt
		claimMemoryNode(t, ctx, store, scope, "gate", created, time.Minute)
		if _, err := store.RecoverExpiredLeases(ctx, scope, created.Add(2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		job = nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobQueued || !job.CreatedAt.Equal(created) {
			t.Fatalf("inside run-start window = %+v", job)
		}
		_ = claimMemoryNode(t, ctx, store, scope, "gate", created.Add(time.Hour-2*time.Minute), time.Minute)
		if _, err := store.RecoverExpiredLeases(ctx, scope, created.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		job = nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobFailed || !job.CreatedAt.Equal(created) {
			t.Fatalf("at run start limit = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)
	})
	t.Run("pending expires_at", func(t *testing.T) {
		store, scope, exec := startMemoryRun(t, ctx, delayThenGateYAML("PT1H"))
		created := nodeJob(t, ctx, store, scope, exec.ID, "gate").CreatedAt
		finish := created.Add(2 * time.Hour)
		completeMemoryNode(t, ctx, store, scope, "pause", finish)
		claimMemoryNode(t, ctx, store, scope, "gate", finish, time.Minute)
		expires := finish.Add(3 * time.Hour)
		var closed int
		store.SetApprovalPending(func(string, string) (time.Time, bool) { return expires, true })
		store.SetApprovalUnresolvable(func(string, string, time.Time) { closed++ })
		// Past the upstream finished_at plus PT1H, still inside expires_at.
		if _, err := store.RecoverExpiredLeases(ctx, scope, finish.Add(90*time.Minute)); err != nil {
			t.Fatal(err)
		}
		job := nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobWaiting || !job.CreatedAt.Equal(created) || closed != 0 {
			t.Fatalf("inside expires_at = %+v closed=%d", job, closed)
		}
	})
	t.Run("pending expires_at closes at the limit", func(t *testing.T) {
		store, scope, exec := startMemoryRun(t, ctx, delayThenGateYAML("PT1H"))
		created := nodeJob(t, ctx, store, scope, exec.ID, "gate").CreatedAt
		finish := created.Add(2 * time.Hour)
		completeMemoryNode(t, ctx, store, scope, "pause", finish)
		expires := finish.Add(3 * time.Hour)
		var closedNode string
		store.SetApprovalPending(func(string, string) (time.Time, bool) { return expires, true })
		store.SetApprovalUnresolvable(func(_, nodeID string, _ time.Time) { closedNode = nodeID })
		claimed := claimMemoryNode(t, ctx, store, scope, "gate", expires.Add(-time.Minute), time.Minute)
		if _, err := store.RecoverExpiredLeases(ctx, scope, expires); err != nil {
			t.Fatal(err)
		}
		job := nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobFailed || job.Attempt != claimed.Job.Attempt || !job.CreatedAt.Equal(created) {
			t.Fatalf("at expires_at = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)
		if closedNode != "gate" {
			t.Fatalf("closed node = %q", closedNode)
		}
	})
	t.Run("survives requeue recovery and restart", func(t *testing.T) {
		store, scope, exec := startMemoryRun(t, ctx, delayThenGateYAML("PT1H"))
		created := nodeJob(t, ctx, store, scope, exec.ID, "gate").CreatedAt
		finish := created.Add(2 * time.Hour)
		completeMemoryNode(t, ctx, store, scope, "pause", finish)
		pause, _ := nodeStep(t, ctx, store, scope, exec.ID, "pause")
		if pause.FinishedAt == nil || !pause.FinishedAt.Equal(finish) {
			t.Fatalf("upstream finished_at = %v", pause.FinishedAt)
		}
		claimed := claimMemoryNode(t, ctx, store, scope, "gate", finish, time.Minute)
		released, err := store.ReleaseJob(ctx, scope, finish, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil || released.Job.Status != JobQueued || !released.Job.CreatedAt.Equal(created) {
			t.Fatalf("requeue = %+v %v", released.Job, err)
		}
		claimed = claimMemoryNode(t, ctx, store, scope, "gate", finish.Add(35*time.Second), time.Minute)
		if _, err := store.RecoverExpiredLeases(ctx, scope, finish.Add(2*time.Minute)); err != nil {
			t.Fatal(err)
		}
		job := nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobQueued || !job.CreatedAt.Equal(created) {
			t.Fatalf("recovery = %+v", job)
		}
		claimed = claimMemoryNode(t, ctx, store, scope, "gate", finish.Add(3*time.Minute), time.Minute)
		if !claimed.Job.CreatedAt.Equal(created) {
			t.Fatalf("restart moved created_at to %s", claimed.Job.CreatedAt)
		}
		again, _ := nodeStep(t, ctx, store, scope, exec.ID, "pause")
		if again.FinishedAt == nil || !again.FinishedAt.Equal(finish) {
			t.Fatalf("finished_at moved to %v", again.FinishedAt)
		}
		if _, err := store.RecoverExpiredLeases(ctx, scope, finish.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		job = nodeJob(t, ctx, store, scope, exec.ID, "gate")
		if job.Status != JobFailed || !job.CreatedAt.Equal(created) {
			t.Fatalf("limit after restart = %+v", job)
		}
		assertUnresolvableGate(t, ctx, store, scope, exec.ID)
	})
}

func startMemoryRun(t *testing.T, ctx context.Context, src string) (*Memory, isolation.Scope, Execution) {
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
	return store, scope, exec
}

func claimMemoryNode(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, node string, now time.Time, lease time.Duration) DispatchResult {
	t.Helper()
	claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: lease})
	if err != nil || claimed.Step.NodeID != node {
		t.Fatalf("claim %s = %s %v", node, claimed.Step.NodeID, err)
	}
	return claimed
}

func completeMemoryNode(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, node string, now time.Time) {
	t.Helper()
	claimed := claimMemoryNode(t, ctx, store, scope, node, now, 5*time.Minute)
	if _, err := store.CompleteJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
		Output: map[string]any{},
	}); err != nil {
		t.Fatal(err)
	}
}

func nodeJob(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, executionID, node string) ExecutionJob {
	t.Helper()
	step, ok := nodeStep(t, ctx, store, scope, executionID, node)
	if !ok {
		t.Fatalf("missing step %s", node)
	}
	jobs, err := store.ListJobs(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		if job.ExecutionStepID == step.ID {
			return job
		}
	}
	t.Fatalf("missing job %s", node)
	return ExecutionJob{}
}

func nodeStep(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, executionID, node string) (ExecutionStep, bool) {
	t.Helper()
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if step.NodeID == node {
			return step, true
		}
	}
	return ExecutionStep{}, false
}

func delayThenGateYAML(expires string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: delay-then-gate
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: pause
      type: flow.delay
      name: Pause
      with:
        duration: PT2H
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: admin
        expiresIn: ` + expires + `
  edges:
    - from: pause.result
      to: gate.request
`
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
