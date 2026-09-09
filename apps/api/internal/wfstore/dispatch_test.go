package wfstore

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestMemoryDispatchLeaseFenceCancelRetry(t *testing.T) {
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

	normalized := mustNormalize(t, coreDispatchYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "e52"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 9, 9, 4, 0, 0, 0, time.UTC)
	first, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker-a", Lease: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if first.Job.FencingToken < 1 || first.Job.Status != JobClaimed {
		t.Fatalf("claim = %+v", first.Job)
	}
	if first.Binding.WorkspaceID != scope.WorkspaceID() || first.Binding.WorkflowDigest != ver.Digest {
		t.Fatalf("binding = %+v", first.Binding)
	}
	if _, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker-b", Lease: time.Second}); !errors.Is(err, ErrEmptyClaim) {
		t.Fatalf("second claim: %v", err)
	}
	if _, err := store.GetJob(ctx, other, first.Job.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-workspace job: %v", err)
	}

	providerCalls := 0
	if err := AuthorizeJobBinding(first.Binding, scope.WorkspaceID(), ver.ID, ver.Digest, now); err != nil {
		t.Fatalf("worker rejected valid job: %v", err)
	}
	hb, err := store.HeartbeatJob(ctx, scope, now.Add(200*time.Millisecond), JobActionInput{
		JobID: first.Job.ID, WorkerID: "worker-a", FencingToken: first.Job.FencingToken, Lease: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if hb.Job.Status != JobRunning {
		t.Fatalf("heartbeat status = %s", hb.Job.Status)
	}
	providerCalls++

	if _, err := store.CompleteJob(ctx, scope, now.Add(300*time.Millisecond), JobActionInput{
		JobID: first.Job.ID, WorkerID: "worker-a", FencingToken: 0,
	}); !errors.Is(err, ErrFenceConflict) {
		t.Fatalf("stale fence: %v", err)
	}

	lost := now.Add(3 * time.Second)
	n, err := store.RecoverExpiredLeases(ctx, scope, lost)
	if err != nil || n != 1 {
		t.Fatalf("recover: n=%d err=%v", n, err)
	}
	got, err := store.GetExecutionByID(ctx, scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != ExecutionIndeterminate {
		t.Fatalf("lease loss status = %s", got.Status)
	}
	if _, err := store.CompleteJob(ctx, scope, lost, JobActionInput{
		JobID: first.Job.ID, WorkerID: "worker-a", FencingToken: first.Job.FencingToken,
		Output: map[string]any{"ok": true},
	}); err == nil {
		t.Fatal("stale worker completed after lease loss")
	}
	if _, err := store.ClaimJob(ctx, scope, lost, ClaimInput{WorkerID: "worker-b", Lease: time.Second}); !errors.Is(err, ErrEmptyClaim) {
		t.Fatalf("reclaim after lease loss: %v", err)
	}
	if providerCalls != 1 {
		t.Fatalf("duplicate provider calls: %d", providerCalls)
	}

	t.Run("cancel is idempotent", func(t *testing.T) {
		exec2, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		canceled, err := store.CancelExecution(ctx, scope, now, exec2.ID)
		if err != nil {
			t.Fatal(err)
		}
		if canceled.Status != ExecutionCanceled {
			t.Fatalf("cancel = %s", canceled.Status)
		}
		again, err := store.CancelExecution(ctx, scope, now, exec2.ID)
		if err != nil || again.Status != ExecutionCanceled {
			t.Fatalf("idempotent cancel: %+v %v", again, err)
		}
		if _, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker-c", Lease: time.Second}); !errors.Is(err, ErrEmptyClaim) {
			t.Fatalf("claimed canceled job: %v", err)
		}
	})

	t.Run("retry policy", func(t *testing.T) {
		k8s := mustNormalize(t, fixtureYAML)
		k8sWF, k8sDraft, err := store.Create(ctx, scope, CreateInput{
			NormalizedYAML: k8s.NormalizedYAML,
			Digest:         k8s.Digest,
			Summary:        k8s.Summary,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, k8sVer, err := store.Publish(ctx, scope, k8sWF.ID, PublishInput{ExpectedRevision: k8sDraft.Revision, Note: "k8s"})
		if err != nil {
			t.Fatal(err)
		}
		k8sExec, err := store.StartExecution(ctx, scope, k8sWF.ID, StartInput{VersionID: k8sVer.ID})
		if err != nil {
			t.Fatal(err)
		}
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker-k", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "worker-k", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "worker-k", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "provider"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now, k8sExec.ID, claimed.Step.ID); !errors.Is(err, ErrRetryNotAllowed) {
			t.Fatalf("provider retry: %v", err)
		}

		safe, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		safeClaim, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "worker-d", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: safeClaim.Job.ID, WorkerID: "worker-d", FencingToken: safeClaim.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, now, JobActionInput{
			JobID: safeClaim.Job.ID, WorkerID: "worker-d", FencingToken: safeClaim.Job.FencingToken,
		}); err != nil {
			t.Fatal(err)
		}
		retried, err := store.RetryStep(ctx, scope, now, safe.ID, safeClaim.Step.ID)
		if err != nil {
			t.Fatal(err)
		}
		if retried.Step.Attempt != 2 || retried.Job.Status != JobQueued {
			t.Fatalf("retry = %+v %+v", retried.Step, retried.Job)
		}
	})
}

const coreDispatchYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e52-dispatch
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          env: staging
  edges: []
`
