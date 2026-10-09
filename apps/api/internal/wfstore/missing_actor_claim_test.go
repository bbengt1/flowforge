package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// #628 F1: the claim, which the in-process runner and the HTTP-claim
// compose worker share, fails a manual or API run with no requester.

const missingActorWS = "11111111-1111-4111-8111-111111111111"
const missingActorUser = "22222222-2222-4222-8222-222222222222"

func publishDispatch(t *testing.T, ctx context.Context, store Store, scope isolation.Scope) (Workflow, Version) {
	t.Helper()
	normalized := mustNormalize(t, coreDispatchYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "628-f1"})
	if err != nil {
		t.Fatal(err)
	}
	return wf, ver
}

// assertMissingActorFailed checks the run failed with missing_actor, the
// step never started, and no job was ever handed a fencing token beyond
// wantFence.
func assertMissingActorFailed(t *testing.T, ctx context.Context, store Store, scope isolation.Scope, wfID, execID string, wantFence int64) {
	t.Helper()
	exec, err := store.GetExecution(ctx, scope, wfID, execID)
	if err != nil {
		t.Fatal(err)
	}
	if exec.Status != ExecutionFailed {
		t.Fatalf("run status = %s, want failed", exec.Status)
	}
	steps, err := store.ListSteps(ctx, scope, execID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) == 0 {
		t.Fatal("no steps")
	}
	for _, step := range steps {
		if step.Status != ExecutionFailed || step.Error["code"] != ReasonMissingActor || step.Error["message"] != MissingActorDetail {
			t.Fatalf("step = %s %+v", step.Status, step.Error)
		}
		if len(step.Output) != 0 {
			t.Fatalf("step produced output: %+v", step.Output)
		}
		if wantFence == 0 && step.StartedAt != nil {
			t.Fatalf("step started at %v", step.StartedAt)
		}
	}
	jobs, err := store.ListJobs(ctx, scope, execID)
	if err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		if job.Status != JobFailed || job.WorkerID != "" || job.LeaseExpiresAt != nil || job.FencingToken != wantFence {
			t.Fatalf("job = %+v", job)
		}
	}
}

func TestMemoryClaimFailsMissingActor(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize(missingActorWS, missingActorUser)
	if err != nil {
		t.Fatal(err)
	}
	sys, err := isolation.AuthorizeSystem(missingActorWS)
	if err != nil {
		t.Fatal(err)
	}
	wf, ver := publishDispatch(t, ctx, store, scope)
	now := time.Now().UTC().Add(time.Second)
	for _, trig := range []string{"manual", "api", ""} {
		exec, err := store.PlantExecutionForTest(ctx, sys, wf.ID, StartInput{VersionID: ver.ID, TriggerType: trig})
		if err != nil {
			t.Fatalf("%q plant: %v", trig, err)
		}
		if _, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("%q claim = %v, want ErrEmptyClaim", trig, err)
		}
		assertMissingActorFailed(t, ctx, store, scope, wf.ID, exec.ID, 0)
	}
	// A schedule run with no requester still claims.
	if _, err := store.StartExecution(ctx, sys, wf.ID, StartInput{VersionID: ver.ID, TriggerType: "schedule"}); err != nil {
		t.Fatal(err)
	}
	res, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker", Lease: time.Minute})
	if err != nil || res.Job.FencingToken != 1 {
		t.Fatalf("schedule claim = %+v, %v", res.Job, err)
	}
}

// A run whose job goes back on the queue (release; recovery and retry end
// in the same claim) is failed when it is claimed again.
func TestMemoryRequeuedMissingActorFailsAtClaim(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize(missingActorWS, missingActorUser)
	if err != nil {
		t.Fatal(err)
	}
	wf, ver := publishDispatch(t, ctx, store, scope)
	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Second)
	first, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	// Plant the corruption: an older row lost its requester.
	store.mu.Lock()
	row := store.executions[exec.ID]
	row.record.RequestedBy = ""
	store.executions[exec.ID] = row
	store.mu.Unlock()
	if _, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
		JobID: first.Job.ID, WorkerID: "worker", FencingToken: first.Job.FencingToken,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ClaimJob(ctx, scope, now.Add(time.Minute), ClaimInput{WorkerID: "worker", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
		t.Fatalf("requeued claim = %v, want ErrEmptyClaim", err)
	}
	assertMissingActorFailed(t, ctx, store, scope, wf.ID, exec.ID, first.Job.FencingToken)
}

func TestPostgresClaimFailsMissingActor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	dsn := testDatabaseURL(t)
	admin, err := postgres.OpenAdmin(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	app, err := postgres.Open(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer app.Close()
	store := NewPostgres(app)
	ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}
	wf, ver := publishDispatch(t, ctx, store, scope)
	claim := func(at time.Time) (DispatchResult, error) {
		return store.ClaimJob(ctx, scope, at, ClaimInput{WorkerID: "pg-worker", Lease: time.Minute})
	}
	plant := func(trig string) string {
		t.Helper()
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID, TriggerType: trig})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `UPDATE executions SET requested_by = NULL WHERE id = $1::uuid`, exec.ID); err != nil {
			t.Fatal(err)
		}
		return exec.ID
	}

	t.Run("planted", func(t *testing.T) {
		for _, trig := range []string{"manual", "api"} {
			id := plant(trig)
			if _, err := claim(time.Now().UTC().Add(time.Second)); !errors.Is(err, ErrEmptyClaim) {
				t.Fatalf("%s claim = %v, want ErrEmptyClaim", trig, err)
			}
			assertMissingActorFailed(t, ctx, store, scope, wf.ID, id, 0)
		}
	})

	t.Run("requeued", func(t *testing.T) {
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC().Add(time.Second)
		first, err := claim(now)
		if err != nil {
			t.Fatal(err)
		}
		if first.Execution.ID != exec.ID {
			t.Fatalf("claimed %s, want %s", first.Execution.ID, exec.ID)
		}
		if _, err := admin.Exec(ctx, `UPDATE executions SET requested_by = NULL WHERE id = $1::uuid`, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
			JobID: first.Job.ID, WorkerID: "pg-worker", FencingToken: first.Job.FencingToken,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := claim(now.Add(time.Minute)); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("requeued claim = %v, want ErrEmptyClaim", err)
		}
		assertMissingActorFailed(t, ctx, store, scope, wf.ID, exec.ID, first.Job.FencingToken)
	})

	t.Run("schedule still claims", func(t *testing.T) {
		sys, err := isolation.AuthorizeSystem(ws)
		if err != nil {
			t.Fatal(err)
		}
		exec, err := store.StartExecution(ctx, sys, wf.ID, StartInput{VersionID: ver.ID, TriggerType: "schedule"})
		if err != nil {
			t.Fatal(err)
		}
		res, err := claim(time.Now().UTC().Add(time.Second))
		if err != nil || res.Execution.ID != exec.ID || res.Job.FencingToken != 1 {
			t.Fatalf("schedule claim = %+v, %v", res.Job, err)
		}
	})
}
