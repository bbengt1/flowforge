package workflowhttp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestRetryConflictDoesNotUseSlugMessage(t *testing.T) {
	cases := []error{
		&wfstore.NotRetryableError{Reason: wfstore.ReasonRunCanceled},
		wfstore.ErrStepAttemptSuperseded,
		wfstore.ErrConstraint,
	}
	for _, err := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/executions/x/steps/y/retry", nil)
		WriteWorkflowStoreError(rec, req, err)
		if rec.Code != http.StatusConflict {
			t.Fatalf("%v status %d", err, rec.Code)
		}
		body := rec.Body.String()
		if strings.Contains(body, "slug already exists") {
			t.Fatalf("slug message for %v: %s", err, body)
		}
		var problem core.Problem
		if decErr := json.Unmarshal(rec.Body.Bytes(), &problem); decErr != nil {
			t.Fatal(decErr)
		}
		switch err {
		case wfstore.ErrStepAttemptSuperseded:
			if problem.Code != core.CodeStepAttemptSuperseded {
				t.Fatalf("code = %s", problem.Code)
			}
		case wfstore.ErrConstraint:
			if problem.Code != core.CodeConflict || problem.Detail == "" {
				t.Fatalf("constraint = %+v", problem)
			}
		default:
			if problem.Code != core.CodeExecutionNotRetryable || problem.Reason != wfstore.ReasonRunCanceled {
				t.Fatalf("not retryable = %+v", problem)
			}
		}
	}
}

func TestEveryRetryRefusalAgreesOnCodeAndReason(t *testing.T) {
	cases := []struct {
		err    error
		code   string
		reason string
	}{
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonRunCanceled}, core.CodeExecutionNotRetryable, wfstore.ReasonRunCanceled},
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonRunNotFailed}, core.CodeExecutionNotRetryable, wfstore.ReasonRunNotFailed},
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonStepNotStarted}, core.CodeExecutionNotRetryable, wfstore.ReasonStepNotStarted},
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonStepNotFailed}, core.CodeExecutionNotRetryable, wfstore.ReasonStepNotFailed},
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonIncomingUnresolved}, core.CodeExecutionNotRetryable, wfstore.ReasonIncomingUnresolved},
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonRetryNotAllowed}, core.CodeExecutionNotRetryable, wfstore.ReasonRetryNotAllowed},
		{&wfstore.NotRetryableError{Reason: wfstore.ReasonWorkflowDeleted}, core.CodeExecutionNotRetryable, wfstore.ReasonWorkflowDeleted},
		{wfstore.ErrRetryNotAllowed, core.CodeExecutionNotRetryable, wfstore.ReasonRetryNotAllowed},
		{wfstore.ErrRetryDenied, core.CodeExecutionNotRetryable, wfstore.ReasonRetryNotAllowed},
		{wfstore.ErrStepAttemptSuperseded, core.CodeStepAttemptSuperseded, ""},
	}
	for _, tc := range cases {
		fromErr := problemFor(t, func(w http.ResponseWriter, r *http.Request) {
			WriteWorkflowStoreError(w, r, tc.err)
		})
		fromCap := problemFor(t, func(w http.ResponseWriter, r *http.Request) {
			writeRetryCapability(w, r, wfstore.RetryCapability{Allowed: false, Code: tc.code, Reason: tc.reason})
		})
		if fromErr.Code != tc.code || fromErr.Reason != tc.reason || fromCap.Code != fromErr.Code || fromCap.Reason != fromErr.Reason {
			t.Fatalf("%v err=%+v cap=%+v", tc.err, fromErr, fromCap)
		}
		if strings.Contains(fromErr.Detail, "slug already exists") {
			t.Fatalf("slug message for %v", tc.err)
		}
	}

	ctx := context.Background()
	later := func() time.Time { return time.Now().UTC().Add(time.Second) }
	t.Run("canceled", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeChainYAML)
		claimed := claimAgree(t, store, scope, later(), "seed")
		if _, err := store.CancelExecution(ctx, scope, later(), exec.ID); err != nil {
			t.Fatal(err)
		}
		assertStepRetryAgrees(t, store, scope, exec.ID, claimed.Step.ID)
	})
	t.Run("not failed", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeChainYAML)
		claimed := claimAgree(t, store, scope, later(), "seed")
		assertStepRetryAgrees(t, store, scope, exec.ID, claimed.Step.ID)
	})
	t.Run("not started", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeChainYAML)
		claimed := claimAgree(t, store, scope, later(), "seed")
		if _, err := store.FailJob(ctx, scope, later(), wfstore.JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "agree-worker", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		next := agreeStep(t, store, scope, exec.ID, "next")
		assertStepRetryAgrees(t, store, scope, exec.ID, next.ID)
	})
	t.Run("not failed step", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeChainYAML)
		claimed := claimAgree(t, store, scope, later(), "seed")
		if _, err := store.CompleteJob(ctx, scope, later(), wfstore.JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "agree-worker", FencingToken: claimed.Job.FencingToken,
			Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}},
		}); err != nil {
			t.Fatal(err)
		}
		nextClaim := claimAgree(t, store, scope, later(), "next")
		if _, err := store.FailJob(ctx, scope, later(), wfstore.JobActionInput{
			JobID: nextClaim.Job.ID, WorkerID: "agree-worker", FencingToken: nextClaim.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		assertStepRetryAgrees(t, store, scope, exec.ID, claimed.Step.ID)
	})
	t.Run("ssh not allowed", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeSSHYAML)
		claimed := claimAgree(t, store, scope, later(), "run")
		if _, err := store.FailJob(ctx, scope, later(), wfstore.JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "agree-worker", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "command-failed"},
		}); err != nil {
			t.Fatal(err)
		}
		assertStepRetryAgrees(t, store, scope, exec.ID, claimed.Step.ID)
	})
	t.Run("superseded", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeChainYAML)
		claimed := claimAgree(t, store, scope, later(), "seed")
		if _, err := store.FailJob(ctx, scope, later(), wfstore.JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "agree-worker", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, later(), exec.ID, claimed.Step.ID); err != nil {
			t.Fatal(err)
		}
		assertStepRetryAgrees(t, store, scope, exec.ID, claimed.Step.ID)
	})
	t.Run("workflow deleted", func(t *testing.T) {
		store, scope, exec := startAgreeRun(t, agreeChainYAML)
		claimed := claimAgree(t, store, scope, later(), "seed")
		if _, err := store.FailJob(ctx, scope, later(), wfstore.JobActionInput{
			JobID: claimed.Job.ID, WorkerID: "agree-worker", FencingToken: claimed.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Delete(ctx, scope, exec.WorkflowID); err != nil {
			t.Fatal(err)
		}
		assertStepRetryAgrees(t, store, scope, exec.ID, claimed.Step.ID)
	})
}

func problemFor(t *testing.T, write func(http.ResponseWriter, *http.Request)) core.Problem {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/executions/x/steps/y/retry", nil)
	write(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var problem core.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &problem); err != nil {
		t.Fatal(err)
	}
	return problem
}

func assertStepRetryAgrees(t *testing.T, store *wfstore.Memory, scope isolation.Scope, executionID, stepID string) {
	t.Helper()
	ctx := context.Background()
	exec, err := store.GetExecutionByID(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	steps, err := store.ListSteps(ctx, scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.AnnotateRetryCapabilities(ctx, scope, &exec, steps); err != nil {
		t.Fatal(err)
	}
	var stepCap wfstore.RetryCapability
	found := false
	for _, step := range steps {
		if step.ID != stepID || step.Capabilities == nil {
			continue
		}
		stepCap = step.Capabilities.Retry
		found = true
	}
	if !found || stepCap.Allowed {
		t.Fatalf("step capability = %+v found=%v", stepCap, found)
	}
	_, retryErr := store.RetryStep(ctx, scope, time.Now().UTC(), executionID, stepID)
	if retryErr == nil {
		t.Fatal("retry succeeded")
	}
	problem := problemFor(t, func(w http.ResponseWriter, r *http.Request) {
		WriteWorkflowStoreError(w, r, retryErr)
	})
	if problem.Code != stepCap.Code || problem.Reason != stepCap.Reason {
		t.Fatalf("endpoint code=%s reason=%s capability=%+v err=%v", problem.Code, problem.Reason, stepCap, retryErr)
	}
	if exec.Capabilities == nil {
		t.Fatal("missing execution capability")
	}
	if stepCap.Reason == wfstore.ReasonWorkflowDeleted && (exec.Capabilities.Retry.Code != stepCap.Code || exec.Capabilities.Retry.Reason != stepCap.Reason) {
		t.Fatalf("execution capability = %+v", exec.Capabilities.Retry)
	}
}

func startAgreeRun(t *testing.T, src string) (*wfstore.Memory, isolation.Scope, wfstore.Execution) {
	t.Helper()
	ctx := context.Background()
	store := wfstore.NewMemory()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	src = strings.Replace(src, "name: agree", "name: a"+strconv.FormatInt(time.Now().UnixNano(), 36), 1)
	parsed, errs := workflow.ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("parse: %+v", errs)
	}
	wf, draft, err := store.Create(ctx, scope, wfstore.CreateInput{
		NormalizedYAML: parsed.NormalizedYAML,
		Digest:         parsed.Digest,
		Summary:        parsed.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, wfstore.PublishInput{ExpectedRevision: draft.Revision, Note: "agree"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, wf.ID, wfstore.StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return store, scope, exec
}

func claimAgree(t *testing.T, store *wfstore.Memory, scope isolation.Scope, now time.Time, node string) wfstore.DispatchResult {
	t.Helper()
	got, err := store.ClaimJob(context.Background(), scope, now, wfstore.ClaimInput{WorkerID: "agree-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if got.Step.NodeID != node {
		t.Fatalf("claimed %s, want %s", got.Step.NodeID, node)
	}
	return got
}

func agreeStep(t *testing.T, store *wfstore.Memory, scope isolation.Scope, executionID, node string) wfstore.ExecutionStep {
	t.Helper()
	steps, err := store.ListSteps(context.Background(), scope, executionID)
	if err != nil {
		t.Fatal(err)
	}
	var found wfstore.ExecutionStep
	for _, step := range steps {
		if step.NodeID == node && step.Attempt >= found.Attempt {
			found = step
		}
	}
	if found.ID == "" {
		t.Fatalf("missing %s", node)
	}
	return found
}

const agreeChainYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: agree
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: seed
      type: data.set
      name: Seed
      with:
        value:
          ticket: CHG-1
    - id: next
      type: flow.stop
      name: Next
      with:
        status: success
  edges:
    - from: seed.result
      to: next.input
`

const agreeSSHYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: agree
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: run
      type: ssh.run
      name: Run
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
  edges: []
`
