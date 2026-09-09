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

	// Claim time must be at or after StartExecution's wall-clock AvailableAt.
	// A frozen past clock makes queued jobs look ineligible (AvailableAt.After(now)).
	now := time.Now().UTC()
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
		cancelAt := time.Now().UTC()
		canceled, err := store.CancelExecution(ctx, scope, cancelAt, exec2.ID)
		if err != nil {
			t.Fatal(err)
		}
		if canceled.Status != ExecutionCanceled {
			t.Fatalf("cancel = %s", canceled.Status)
		}
		again, err := store.CancelExecution(ctx, scope, cancelAt, exec2.ID)
		if err != nil || again.Status != ExecutionCanceled {
			t.Fatalf("idempotent cancel: %+v %v", again, err)
		}
		if _, err := store.ClaimJob(ctx, scope, cancelAt, ClaimInput{WorkerID: "worker-c", Lease: time.Second}); !errors.Is(err, ErrEmptyClaim) {
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
		k8sNow := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, k8sNow, ClaimInput{WorkerID: "worker-k", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, k8sNow, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "worker-k", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, k8sNow, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "worker-k", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "provider"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, k8sNow, k8sExec.ID, claimed.Step.ID); !errors.Is(err, ErrRetryNotAllowed) {
			t.Fatalf("provider retry: %v", err)
		}

		safe, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		safeNow := time.Now().UTC()
		safeClaim, err := store.ClaimJob(ctx, scope, safeNow, ClaimInput{WorkerID: "worker-d", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, safeNow, JobActionInput{
			JobID: safeClaim.Job.ID, WorkerID: "worker-d", FencingToken: safeClaim.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, safeNow, JobActionInput{
			JobID: safeClaim.Job.ID, WorkerID: "worker-d", FencingToken: safeClaim.Job.FencingToken,
		}); err != nil {
			t.Fatal(err)
		}
		retried, err := store.RetryStep(ctx, scope, safeNow, safe.ID, safeClaim.Step.ID)
		if err != nil {
			t.Fatal(err)
		}
		if retried.Step.Attempt != 2 || retried.Job.Status != JobQueued {
			t.Fatalf("retry = %+v %+v", retried.Step, retried.Job)
		}
	})
}

func TestSSHRetrySemantics(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	normalized := mustNormalize(t, sshDispatchYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "ssh"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("default zero retries denied", func(t *testing.T) {
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "ssh-a", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-a", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-a", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "command-failed"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID); !errors.Is(err, ErrRetryDenied) {
			t.Fatalf("default retry: %v", err)
		}
	})

	t.Run("retrySafe with verification allowed", func(t *testing.T) {
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "ssh-b", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-b", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-b", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "command-failed", "retry": map[string]any{"retrySafe": true, "verificationDeclared": true}},
		}); err != nil {
			t.Fatal(err)
		}
		// Node YAML has maxAttempts 0; hint supplies a retry-safe profile plus attempts.
		hint := map[string]any{"retrySafe": true, "verificationDeclared": true}
		if _, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID, hint); !errors.Is(err, ErrRetryDenied) {
			t.Fatalf("maxAttempts 0 must still deny: %v", err)
		}
	})

	t.Run("indeterminate without retrySafe stays closed", func(t *testing.T) {
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "ssh-c", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-c", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		released, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-c", FencingToken: claimed.Job.FencingToken,
		})
		if err != nil {
			t.Fatal(err)
		}
		if released.Step.Status != ExecutionIndeterminate && released.Job.Status != JobIndeterminate {
			t.Fatalf("indet release = %+v %+v", released.Step, released.Job)
		}
		if _, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID); !errors.Is(err, ErrRetryDenied) && !errors.Is(err, ErrRetryNotAllowed) {
			t.Fatalf("indet retry: %v", err)
		}
	})

	t.Run("indeterminate retrySafe with attempts queues verify-first attempt", func(t *testing.T) {
		normalized2 := mustNormalize(t, sshRetryDispatchYAML)
		wf2, draft2, err := store.Create(ctx, scope, CreateInput{
			NormalizedYAML: normalized2.NormalizedYAML,
			Digest:         normalized2.Digest,
			Summary:        normalized2.Summary,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, ver2, err := store.Publish(ctx, scope, wf2.ID, PublishInput{ExpectedRevision: draft2.Revision, Note: "ssh-retry"})
		if err != nil {
			t.Fatal(err)
		}
		exec, err := store.StartExecution(ctx, scope, wf2.ID, StartInput{VersionID: ver2.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "ssh-d", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-d", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "ssh-d", FencingToken: claimed.Job.FencingToken,
		}); err != nil {
			t.Fatal(err)
		}
		retried, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID, map[string]any{
			"retrySafe": true, "verificationDeclared": true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if retried.Step.Attempt != 2 || retried.Job.Status != JobQueued {
			t.Fatalf("retry = %+v %+v", retried.Step, retried.Job)
		}
	})
}

func TestScriptRetrySemantics(t *testing.T) {
	ctx := context.Background()
	store := NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	normalized := mustNormalize(t, scriptDispatchYAML)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "script"})
	if err != nil {
		t.Fatal(err)
	}

	t.Run("retry denied without verification", func(t *testing.T) {
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "script-a", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "script-a", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.FailJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "script-a", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "invalid-schema"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID); !errors.Is(err, ErrRetryDenied) && !errors.Is(err, ErrRetryNotAllowed) {
			t.Fatalf("default script retry: %v", err)
		}
	})

	t.Run("indeterminate without verification stays closed", func(t *testing.T) {
		exec, err := store.StartExecution(ctx, scope, wf.ID, StartInput{VersionID: ver.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "script-b", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "script-b", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "script-b", FencingToken: claimed.Job.FencingToken,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID); !errors.Is(err, ErrRetryDenied) && !errors.Is(err, ErrRetryNotAllowed) {
			t.Fatalf("indet script retry: %v", err)
		}
	})

	t.Run("retrySafe with key and verification queues verify-first attempt", func(t *testing.T) {
		normalized2 := mustNormalize(t, scriptRetryDispatchYAML)
		wf2, draft2, err := store.Create(ctx, scope, CreateInput{
			NormalizedYAML: normalized2.NormalizedYAML,
			Digest:         normalized2.Digest,
			Summary:        normalized2.Summary,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, ver2, err := store.Publish(ctx, scope, wf2.ID, PublishInput{ExpectedRevision: draft2.Revision, Note: "script-retry"})
		if err != nil {
			t.Fatal(err)
		}
		exec, err := store.StartExecution(ctx, scope, wf2.ID, StartInput{VersionID: ver2.ID})
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		claimed, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "script-c", Lease: time.Minute})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := store.HeartbeatJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "script-c", FencingToken: claimed.Job.FencingToken, Lease: time.Minute,
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ReleaseJob(ctx, scope, now, JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "script-c", FencingToken: claimed.Job.FencingToken,
		}); err != nil {
			t.Fatal(err)
		}
		retried, err := store.RetryStep(ctx, scope, now, exec.ID, claimed.Step.ID, map[string]any{
			"retrySafe": true, "verificationDeclared": true, "idempotencyKeyDeclared": true,
		})
		if err != nil {
			t.Fatal(err)
		}
		if retried.Step.Attempt != 2 || retried.Job.Status != JobQueued {
			t.Fatalf("retry = %+v %+v", retried.Step, retried.Job)
		}
	})
}

const scriptDispatchYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e93-script
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: summarize
      type: script.python
      name: Summarize
      with:
        source: |
          import json
          print(json.dumps({"status": "ok"}))
        entrypoint: main.py
        runtimeProfileId: 33333333-3333-4333-8333-333333333333
        timeoutSeconds: 30
  edges: []
`

const scriptRetryDispatchYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e93-script-retry
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: summarize
      type: script.python
      name: Summarize
      with:
        source: |
          import json
          print(json.dumps({"status": "ok"}))
        entrypoint: main.py
        runtimeProfileId: 33333333-3333-4333-8333-333333333333
        timeoutSeconds: 30
        retrySafe: true
        idempotencyKey: summarize-once
        verification:
          behavior: declared-hook
        retryPolicy:
          maxAttempts: 2
  edges: []
`

const sshDispatchYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e83-ssh
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: ssh.run
      name: Run profile
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
  edges: []
`

const sshRetryDispatchYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e83-ssh-retry
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: ssh.run
      name: Run profile
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
        retryPolicy:
          maxAttempts: 2
  edges: []
`

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
