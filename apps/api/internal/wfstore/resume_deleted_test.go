package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestResumeAfterDeleteStopsTheRun(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := deleteScope(t)
	now := time.Now().UTC()
	ver := publishFixture(t, store, scope, "resume-deleted")
	exec, job := parkWaiting(t, store, scope, ver, now.Add(time.Hour))

	held := store.executions[exec.ID]
	extraStep := cloneStep(held.steps[0])
	extraStep.ID = newID()
	extraStep.Status = ExecutionWaiting
	extraJob := ExecutionJob{
		ID:              newID(),
		ExecutionID:     exec.ID,
		ExecutionStepID: extraStep.ID,
		Status:          JobWaiting,
		AvailableAt:     now.Add(time.Hour),
		CreatedAt:       now,
		UpdatedAt:       now,
	}
	held.steps = append(held.steps, extraStep)
	held.jobs = append(held.jobs, extraJob)
	store.executions[exec.ID] = held

	if _, err := store.Delete(ctx, scope, ver.WorkflowID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ResumeWait(ctx, scope, now, ResumeWaitInput{JobID: job.ID, Port: "approved"}); !errors.Is(err, ErrWorkflowDeleted) {
		t.Fatalf("resume = %v", err)
	}
	got, err := store.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ExecutionFailed {
		t.Fatalf("status = %s", got.Status)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) < 2 {
		t.Fatalf("steps = %+v", steps)
	}
	for _, step := range steps {
		if code, _ := step.Error["code"].(string); code != ReasonWorkflowDeleted {
			t.Fatalf("step error = %+v", step.Error)
		}
		if port, _ := step.Output["port"].(string); port == "approved" || port == "expired" {
			t.Fatalf("port = %s", port)
		}
	}
	jobs, err := store.ListJobs(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range jobs {
		if item.Status != JobFailed {
			t.Fatalf("job = %+v", item)
		}
	}
	if _, err := store.GetExecution(ctx, scope, ver.WorkflowID, exec.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("workflow-scoped get = %v", err)
	}
}

func TestTimerResumeAfterDeleteDoesNotExpire(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := deleteScope(t)
	now := time.Now().UTC()
	ver := publishFixture(t, store, scope, "timer-deleted")
	exec, _ := parkWaiting(t, store, scope, ver, now.Add(-time.Second))
	if _, err := store.Delete(ctx, scope, ver.WorkflowID); err != nil {
		t.Fatal(err)
	}
	n, err := store.RecoverExpiredLeases(ctx, scope, now)
	if err != nil {
		t.Fatal(err)
	}
	if n < 1 {
		t.Fatalf("recovered = %d", n)
	}
	got, err := store.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ExecutionFailed {
		t.Fatalf("status = %s", got.Status)
	}
	steps, err := store.ListSteps(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, step := range steps {
		if port, _ := step.Output["port"].(string); port == "expired" {
			t.Fatalf("expired port on deleted workflow: %+v", step.Output)
		}
		if code, _ := step.Error["code"].(string); code != ReasonWorkflowDeleted {
			t.Fatalf("step error = %+v", step.Error)
		}
	}
}

func TestLiveResumeStillSucceeds(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := deleteScope(t)
	now := time.Now().UTC()
	ver := publishFixture(t, store, scope, "resume-live")
	exec, job := parkWaiting(t, store, scope, ver, now.Add(time.Hour))
	resumed, err := store.ResumeWait(ctx, scope, now, ResumeWaitInput{JobID: job.ID, Port: "approved"})
	if err != nil {
		t.Fatal(err)
	}
	if resumed.Execution.Status != ExecutionSucceeded || resumed.Job.Status != JobSucceeded {
		t.Fatalf("resume = %+v %+v", resumed.Execution, resumed.Job)
	}
	if port, _ := resumed.Step.Output["port"].(string); port != "approved" {
		t.Fatalf("port = %+v", resumed.Step.Output)
	}
	got, err := store.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil || got.Status != ExecutionSucceeded {
		t.Fatalf("get = %+v %v", got, err)
	}
}

func TestRetryAndClaimAfterDeleteDoNotContinue(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope := deleteScope(t)
	now := time.Now().UTC()

	normalized := mustNormalize(t, coreDispatchYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC(), ClaimInput{WorkerID: "worker-retry", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "worker-retry", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.FailJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "worker-retry", FencingToken: claimed.Job.FencingToken,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Delete(ctx, scope, wf.ID); err != nil {
		t.Fatal(err)
	}
	_, err = store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID)
	var refused *NotRetryableError
	if !errors.As(err, &refused) || refused.Reason != ReasonWorkflowDeleted {
		t.Fatalf("retry = %v", err)
	}
	jobs, err := store.ListJobs(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(jobs) != 1 || jobs[0].Status == JobQueued {
		t.Fatalf("jobs = %+v", jobs)
	}

	ver2 := publishFixture(t, store, scope, "claim-deleted")
	waiting, waitJob := parkWaiting(t, store, scope, ver2, now.Add(time.Hour))
	if _, err := store.Delete(ctx, scope, ver2.WorkflowID); err != nil {
		t.Fatal(err)
	}
	held := store.executions[waiting.ID]
	held.record.Status = ExecutionQueued
	held.jobs[0].Status = JobQueued
	held.jobs[0].AvailableAt = now
	store.executions[waiting.ID] = held
	if _, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker-claim", Lease: time.Minute}); !errors.Is(err, ErrEmptyClaim) {
		t.Fatalf("claim = %v", err)
	}
	got, err := store.GetExecutionByID(ctx, scope, waiting.ID)
	if err != nil || got.Status != ExecutionFailed {
		t.Fatalf("claimed tombstone = %+v %v", got, err)
	}
	_ = waitJob
}

func TestResumeAndDeleteSerialize(t *testing.T) {
	ctx := context.Background()
	scope := deleteScope(t)
	now := time.Now().UTC()

	t.Run("resume holds the lock", func(t *testing.T) {
		store := NewMemory()
		ver := publishFixture(t, store, scope, "lock-resume")
		_, job := parkWaiting(t, store, scope, ver, now.Add(time.Hour))
		started := make(chan struct{})
		errCh := make(chan error, 1)
		resumeCtx := WithWorkflowRowLockHook(ctx, func() {
			go func() {
				close(started)
				_, err := store.Delete(context.Background(), scope, ver.WorkflowID)
				errCh <- err
			}()
			<-started
		})
		resumed, err := store.ResumeWait(resumeCtx, scope, now, ResumeWaitInput{JobID: job.ID, Port: "approved"})
		if err != nil {
			t.Fatal(err)
		}
		if resumed.Execution.Status != ExecutionSucceeded {
			t.Fatalf("resume = %s", resumed.Execution.Status)
		}
		if err := <-errCh; err != nil {
			t.Fatalf("delete after resume = %v", err)
		}
	})

	t.Run("delete holds the lock", func(t *testing.T) {
		store := NewMemory()
		ver := publishFixture(t, store, scope, "lock-delete")
		exec, job := parkWaiting(t, store, scope, ver, now.Add(time.Hour))
		started := make(chan struct{})
		errCh := make(chan error, 1)
		deleteCtx := WithWorkflowRowLockHook(ctx, func() {
			go func() {
				close(started)
				_, err := store.ResumeWait(context.Background(), scope, now, ResumeWaitInput{JobID: job.ID, Port: "approved"})
				errCh <- err
			}()
			<-started
		})
		if _, err := store.Delete(deleteCtx, scope, ver.WorkflowID); err != nil {
			t.Fatal(err)
		}
		if err := <-errCh; !errors.Is(err, ErrWorkflowDeleted) {
			t.Fatalf("resume = %v", err)
		}
		got, err := store.GetExecutionByID(ctx, scope, exec.ID)
		if err != nil || got.Status != ExecutionFailed {
			t.Fatalf("after delete wins = %+v %v", got, err)
		}
	})
}

func parkWaiting(t *testing.T, store *Memory, scope isolation.Scope, ver Version, available time.Time) (Execution, ExecutionJob) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := store.ClaimJob(ctx, scope, time.Now().UTC(), ClaimInput{WorkerID: "worker-park", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	parked, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: claimed.Job.ID, AvailableAt: available})
	if err != nil {
		t.Fatal(err)
	}
	if parked.Job.Status != JobWaiting || parked.Execution.Status != ExecutionWaiting {
		t.Fatalf("park = %s %s", parked.Job.Status, parked.Execution.Status)
	}
	return exec, parked.Job
}
