package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestApprovalBackoffGrowsToCap(t *testing.T) {
	bands := [][2]time.Duration{
		{4 * time.Second, 5 * time.Second},
		{8 * time.Second, 10 * time.Second},
		{16 * time.Second, 20 * time.Second},
		{32 * time.Second, 40 * time.Second},
		{48 * time.Second, 60 * time.Second},
		{48 * time.Second, 60 * time.Second},
	}
	prior := 0
	var prevLo time.Duration
	for i, band := range bands {
		lo, n := approvalBackoff(prior, 0)
		hi, nHi := approvalBackoff(prior, 1)
		if n != i+1 || nHi != i+1 {
			t.Fatalf("count = %d/%d want %d", n, nHi, i+1)
		}
		if lo < band[0]-time.Millisecond || hi > band[1]+time.Millisecond || lo > hi {
			t.Fatalf("retry %d delay %s..%s want %s..%s", i+1, lo, hi, band[0], band[1])
		}
		if lo+time.Millisecond < prevLo && band[0] < approvalBackoffCap {
			t.Fatalf("retry %d shrank %s -> %s", i+1, prevLo, lo)
		}
		prevLo = lo
		prior = n
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
	if plain.Job.Status != JobQueued || plain.Job.TransientRetries != 0 || plain.Job.Attempt != attempt || plain.Job.AvailableAt.After(now) {
		t.Fatalf("plain release = %+v", plain.Job)
	}
	claimed, err = store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	clock := now
	var delays []time.Duration
	for i := 0; i < 6; i++ {
		released, err := store.ReleaseJob(ctx, scope, clock, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "edge-worker", FencingToken: claimed.Job.FencingToken,
			ApprovalTransientRetry: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Job.Status != JobQueued || released.Job.Attempt != attempt || released.Job.TransientRetries != i+1 {
			t.Fatalf("release %d = %+v", i, released.Job)
		}
		delays = append(delays, released.Job.AvailableAt.Sub(clock))
		if _, err := store.ClaimJob(ctx, scope, clock.Add(time.Second), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("claimed inside backoff %d: %v", i, err)
		}
		clock = released.Job.AvailableAt
		claimed, err = store.ClaimJob(ctx, scope, clock, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
		if err != nil || claimed.Job.Attempt != attempt {
			t.Fatalf("reclaim %d = %+v %v", i, claimed.Job, err)
		}
	}
	assertBackoffBands(t, delays)
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
	if job.Status != JobQueued || job.Attempt != attempt || job.TransientRetries != 1 {
		t.Fatalf("requeue = %+v", job)
	}
	delay := job.AvailableAt.Sub(recoverAt)
	if delay < 4*time.Second-time.Millisecond || delay > 5*time.Second+time.Millisecond {
		t.Fatalf("first recovery delay = %s", delay)
	}
	if _, err := store.ClaimJob(ctx, scope, recoverAt.Add(time.Second), ClaimInput{WorkerID: "edge-worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
		t.Fatalf("claimed inside recovery backoff: %v", err)
	}
	claimed, err = store.ClaimJob(ctx, scope, job.AvailableAt, ClaimInput{WorkerID: "edge-worker", Lease: time.Minute})
	if err != nil || claimed.Job.Attempt != attempt {
		t.Fatalf("reclaim = %+v %v", claimed.Job, err)
	}
	second := job.AvailableAt.Add(2 * time.Minute)
	if _, err := store.RecoverExpiredLeases(ctx, scope, second); err != nil {
		t.Fatal(err)
	}
	job = gateJob(t, ctx, store, scope, exec.ID)
	if job.Status != JobQueued || job.Attempt != attempt || job.TransientRetries != 2 {
		t.Fatalf("second requeue = %+v", job)
	}
	delay = job.AvailableAt.Sub(second)
	if delay < 8*time.Second-time.Millisecond || delay > 10*time.Second+time.Millisecond {
		t.Fatalf("second recovery delay = %s", delay)
	}
	assertNotExpired(t, ctx, store, scope, exec.ID)
}

func assertBackoffBands(t *testing.T, delays []time.Duration) {
	t.Helper()
	bands := [][2]time.Duration{
		{4 * time.Second, 5 * time.Second},
		{8 * time.Second, 10 * time.Second},
		{16 * time.Second, 20 * time.Second},
		{32 * time.Second, 40 * time.Second},
		{48 * time.Second, 60 * time.Second},
		{48 * time.Second, 60 * time.Second},
	}
	if len(delays) != len(bands) {
		t.Fatalf("delays = %v", delays)
	}
	for i, band := range bands {
		if delays[i] < band[0]-time.Millisecond || delays[i] > band[1]+time.Millisecond {
			t.Fatalf("delay %d = %s want %s..%s", i+1, delays[i], band[0], band[1])
		}
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
