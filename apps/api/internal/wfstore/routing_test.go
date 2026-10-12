package wfstore

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// routeYAML: seed -> boom (flow.fail) ; boom.result -> after ; boom.error -> handled (errorOutput only).
func routeYAML(mode string) string {
	onErr, errEdge := "", ""
	if mode != "" {
		onErr = "\n      onError: " + mode
	}
	if mode == "errorOutput" {
		errEdge = "\n    - from: boom.error\n      to: handled.input"
	}
	handled := ""
	if mode == "errorOutput" {
		handled = `
    - id: handled
      type: flow.stop
      name: Handled
      with:
        status: success`
	}
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: route-` + strings.ToLower(mode) + `x
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
          env: staging
    - id: boom
      type: flow.fail
      name: Boom` + onErr + `
      with:
        code: fixture.boom
    - id: after
      type: flow.stop
      name: After
      with:
        status: success` + handled + `
  edges:
    - from: seed.result
      to: boom.input
    - from: boom.result
      to: after.input` + errEdge + `
`
}

type routeHarness struct {
	fresh func() Store
	t     *testing.T
	ctx   context.Context
	store Store
	scope isolation.Scope
}

func (h routeHarness) now() time.Time { return time.Now().UTC().Add(time.Second) }

func (h routeHarness) start(src string) (Execution, string) {
	h.t.Helper()
	src = strings.Replace(src, "\n  name: ", "\n  name: n"+strconv.FormatInt(time.Now().UnixNano(), 36)+"-", 1)
	n := mustNormalize(h.t, src)
	wf, draft, err := h.store.Create(h.ctx, h.scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
	if err != nil {
		h.t.Fatal(err)
	}
	_, ver, err := h.store.Publish(h.ctx, h.scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		h.t.Fatal(err)
	}
	exec, err := h.store.StartExecution(h.ctx, h.scope, wf.ID, StartInput{VersionID: ver.ID})
	if err != nil {
		h.t.Fatal(err)
	}
	return exec, wf.ID
}

func (h routeHarness) claim(node string) DispatchResult {
	h.t.Helper()
	got, err := h.store.ClaimJob(h.ctx, h.scope, h.now(), ClaimInput{WorkerID: "route-worker", Lease: time.Minute})
	if err != nil || got.Step.NodeID != node {
		h.t.Fatalf("claim %s = %q %v", node, got.Step.NodeID, err)
	}
	return got
}

func (h routeHarness) complete(c DispatchResult, out map[string]any) {
	h.t.Helper()
	if _, err := h.store.CompleteJob(h.ctx, h.scope, h.now(), JobActionInput{JobID: c.Job.ID, WorkerID: "route-worker", FencingToken: c.Job.FencingToken, Output: out}); err != nil {
		h.t.Fatal(err)
	}
}

func (h routeHarness) fail(c DispatchResult) {
	h.t.Helper()
	if _, err := h.store.FailJob(h.ctx, h.scope, h.now(), JobActionInput{
		JobID: c.Job.ID, WorkerID: "route-worker", FencingToken: c.Job.FencingToken,
		Error: map[string]any{"code": "fixture.boom", "message": "planned failure"},
	}); err != nil {
		h.t.Fatal(err)
	}
}

func (h routeHarness) step(execID, node string) (ExecutionStep, ExecutionJob) {
	h.t.Helper()
	steps, err := h.store.ListSteps(h.ctx, h.scope, execID)
	if err != nil {
		h.t.Fatal(err)
	}
	jobs, err := h.store.ListJobs(h.ctx, h.scope, execID)
	if err != nil {
		h.t.Fatal(err)
	}
	return stepByNode(h.t, steps, node), jobByNode(h.t, jobs, steps, node)
}

func (h routeHarness) run(execID string) Execution {
	h.t.Helper()
	got, err := h.store.GetExecutionByID(h.ctx, h.scope, execID)
	if err != nil {
		h.t.Fatal(err)
	}
	return got
}

func (h routeHarness) audits(execID, action string) int {
	h.t.Helper()
	got, err := h.store.ListAuditEvents(h.ctx, h.scope, AuditListFilter{Action: action, ResourceID: execID})
	if err != nil {
		h.t.Fatal(err)
	}
	return len(got)
}

func runRoutingSuite(t *testing.T, h routeHarness) {
	t.Run("errorOutput routes only the error port", func(t *testing.T) {
		h.t = t
		if h.fresh != nil {
			h.store = h.fresh()
		}
		exec, _ := h.start(routeYAML("errorOutput"))
		h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"env": "staging"}})
		boom := h.claim("boom")
		h.fail(boom)
		s, j := h.step(exec.ID, "boom")
		if s.Status != ExecutionFailed || j.Status != JobFailed || s.ErrorHandling != ErrorHandlingOutput {
			t.Fatalf("boom = %s/%s %q", s.Status, j.Status, s.ErrorHandling)
		}
		if _, leaked := s.Error["handling"]; leaked {
			t.Fatalf("marker leaked into error: %+v", s.Error)
		}
		payload, _ := s.Output["error"].(map[string]any)
		if len(payload) != 4 || payload["code"] != "fixture.boom" || payload["message"] != "planned failure" || payload["nodeId"] != "boom" || num(payload["attempt"]) != 1 {
			t.Fatalf("error payload = %+v", s.Output)
		}
		after, aj := h.step(exec.ID, "after")
		if after.Status != ExecutionSkipped || after.SkipReason != SkipBranchNotTaken || aj.Status != JobSkipped {
			t.Fatalf("after = %s %q %s", after.Status, after.SkipReason, aj.Status)
		}
		handled := h.claim("handled")
		in, _ := handled.Inputs["input"].(map[string]any)
		if len(in) != 4 || in["code"] != "fixture.boom" || in["message"] != "planned failure" || in["nodeId"] != "boom" || num(in["attempt"]) != 1 {
			t.Fatalf("handled inputs = %+v", handled.Inputs)
		}
		for _, k := range []string{"handling", "errorHandling"} {
			if _, leaked := in[k]; leaked {
				t.Fatalf("%s leaked into the error payload: %+v", k, in)
			}
		}
		h.complete(handled, map[string]any{"result": map[string]any{"status": "success"}})
		if got := h.run(exec.ID); got.Status != ExecutionSucceededWithErrors {
			t.Fatalf("run = %s", got.Status)
		}
		if n := h.audits(exec.ID, "job.fail"); n != 1 {
			t.Fatalf("job.fail audits = %d", n)
		}
		if n := h.audits(exec.ID, ActionStepErrorRouted); n != 1 {
			t.Fatalf("step.error_routed audits = %d", n)
		}
		// Handled failure in a succeededWithErrors run is not retryable.
		_, err := h.store.RetryStep(h.ctx, h.scope, h.now(), exec.ID, boom.Step.ID)
		var refused *NotRetryableError
		if !errors.As(err, &refused) || refused.Reason != ReasonRunNotFailed {
			t.Fatalf("retry = %v", err)
		}
	})

	t.Run("continue fires main with {}", func(t *testing.T) {
		h.t = t
		if h.fresh != nil {
			h.store = h.fresh()
		}
		exec, _ := h.start(routeYAML("continue"))
		h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"env": "staging"}})
		h.fail(h.claim("boom"))
		s, _ := h.step(exec.ID, "boom")
		if s.Status != ExecutionFailed || s.ErrorHandling != ErrorHandlingContinue {
			t.Fatalf("boom = %s %q", s.Status, s.ErrorHandling)
		}
		after := h.claim("after")
		if in, ok := after.Inputs["input"].(map[string]any); !ok || len(in) != 0 {
			t.Fatalf("after inputs = %+v", after.Inputs)
		}
		h.complete(after, map[string]any{"result": map[string]any{"status": "success"}})
		if got := h.run(exec.ID); got.Status != ExecutionSucceededWithErrors {
			t.Fatalf("run = %s", got.Status)
		}
		if n := h.audits(exec.ID, "job.fail"); n != 1 {
			t.Fatalf("job.fail audits = %d", n)
		}
	})

	t.Run("plain flow.fail stops the run", func(t *testing.T) {
		h.t = t
		if h.fresh != nil {
			h.store = h.fresh()
		}
		exec, _ := h.start(routeYAML(""))
		h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"env": "staging"}})
		h.fail(h.claim("boom"))
		s, _ := h.step(exec.ID, "boom")
		if s.Status != ExecutionFailed || s.ErrorHandling != "" {
			t.Fatalf("boom = %s %q", s.Status, s.ErrorHandling)
		}
		after, _ := h.step(exec.ID, "after")
		if after.Status != ExecutionSkipped || after.SkipReason != SkipUpstreamFailed {
			t.Fatalf("after = %s %q", after.Status, after.SkipReason)
		}
		if got := h.run(exec.ID); got.Status != ExecutionFailed {
			t.Fatalf("run = %s", got.Status)
		}
		if n := h.audits(exec.ID, ActionStepErrorRouted); n != 0 {
			t.Fatalf("routed audits = %d", n)
		}
	})

	t.Run("pinned version decides, not the edited draft", func(t *testing.T) {
		h.t = t
		if h.fresh != nil {
			h.store = h.fresh()
		}
		exec, wfID := h.start(routeYAML("continue"))
		edited := mustNormalize(t, strings.Replace(routeYAML(""), "\n  name: ", "\n  name: pinned-", 1))
		draft, err := h.store.GetDraft(h.ctx, h.scope, wfID)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := h.store.SaveDraft(h.ctx, h.scope, wfID, SaveInput{ExpectedRevision: draft.Revision, NormalizedYAML: edited.NormalizedYAML, Digest: edited.Digest, Summary: edited.Summary}); err != nil {
			t.Fatal(err)
		}
		h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"env": "staging"}})
		h.fail(h.claim("boom"))
		if s, _ := h.step(exec.ID, "boom"); s.ErrorHandling != ErrorHandlingContinue {
			t.Fatalf("boom errorHandling = %q, want pinned continue", s.ErrorHandling)
		}
		h.complete(h.claim("after"), map[string]any{"result": map[string]any{"status": "success"}})
		if s, _ := h.step(exec.ID, "boom"); s.ErrorHandling != ErrorHandlingContinue {
			t.Fatalf("after run, boom errorHandling = %q", s.ErrorHandling)
		}
	})

	t.Run("handled step in a failed run refuses retry", func(t *testing.T) {
		h.t = t
		if h.fresh != nil {
			h.store = h.fresh()
		}
		exec, _ := h.start(mixedYAML)
		h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"x": 1}})
		claimed := map[string]DispatchResult{}
		for i := 0; i < 2; i++ {
			c, err := h.store.ClaimJob(h.ctx, h.scope, h.now(), ClaimInput{WorkerID: "route-worker", Lease: time.Minute})
			if err != nil {
				t.Fatal(err)
			}
			claimed[c.Step.NodeID] = c
		}
		h.fail(claimed["soft"])
		h.fail(claimed["hard"])
		h.complete(h.claim("next"), map[string]any{"result": map[string]any{"status": "success"}})
		if got := h.run(exec.ID); got.Status != ExecutionFailed {
			t.Fatalf("run = %s", got.Status)
		}
		_, err := h.store.RetryStep(h.ctx, h.scope, h.now(), exec.ID, claimed["soft"].Step.ID)
		var refused *NotRetryableError
		if !errors.As(err, &refused) || refused.Reason != ReasonStepErrorHandled {
			t.Fatalf("retry handled = %v", err)
		}
		tail, _ := h.step(exec.ID, "tail")
		if tail.Status != ExecutionSkipped || tail.SkipReason != SkipUpstreamFailed {
			t.Fatalf("tail before retry = %s %q", tail.Status, tail.SkipReason)
		}
		if _, err := h.store.RetryStep(h.ctx, h.scope, h.now(), exec.ID, claimed["hard"].Step.ID); err != nil {
			t.Fatalf("retry plain = %v", err)
		}
		// The accepted retry reopens upstream_failed steps; the routed step stays failed.
		tail, tj := h.step(exec.ID, "tail")
		if tail.Status != ExecutionPending || tail.SkipReason != "" || tj.Status != JobBlocked {
			t.Fatalf("tail after retry = %s %q %s", tail.Status, tail.SkipReason, tj.Status)
		}
		if soft, _ := h.step(exec.ID, "soft"); soft.Status != ExecutionFailed || soft.ErrorHandling != ErrorHandlingContinue {
			t.Fatalf("soft after retry = %s %q", soft.Status, soft.ErrorHandling)
		}
		h.complete(h.claim("hard"), map[string]any{"result": map[string]any{"status": "failure", "code": "hard.fail"}})
		h.complete(h.claim("tail"), map[string]any{"result": map[string]any{"status": "success"}})
		if got := h.run(exec.ID); got.Status != ExecutionSucceededWithErrors {
			t.Fatalf("run after retry = %s", got.Status)
		}
	})

	t.Run("never-routed failures write no step.error_routed", func(t *testing.T) {
		h.t = t
		if h.fresh != nil {
			h.store = h.fresh()
		}
		for _, code := range []string{"policy-denied", "emergency-stop-denied", ReasonWorkflowDeleted, ReasonRequirementUnresolvable} {
			exec, _ := h.start(routeYAML("continue"))
			h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"env": "staging"}})
			boom := h.claim("boom")
			if _, err := h.store.FailJob(h.ctx, h.scope, h.now(), JobActionInput{
				JobID: boom.Job.ID, WorkerID: "route-worker", FencingToken: boom.Job.FencingToken,
				Error: map[string]any{"code": code, "message": "refused"},
			}); err != nil {
				t.Fatal(err)
			}
			if s, _ := h.step(exec.ID, "boom"); s.ErrorHandling != "" {
				t.Fatalf("%s routed: %q", code, s.ErrorHandling)
			}
			if got := h.run(exec.ID); got.Status != ExecutionFailed {
				t.Fatalf("%s run = %s", code, got.Status)
			}
			if n := h.audits(exec.ID, ActionStepErrorRouted); n != 0 {
				t.Fatalf("%s routed audits = %d", code, n)
			}
		}
		// Cancel while the routed node runs.
		exec, _ := h.start(routeYAML("continue"))
		h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"env": "staging"}})
		h.claim("boom")
		if _, err := h.store.CancelExecution(h.ctx, h.scope, h.now(), exec.ID); err != nil {
			t.Fatal(err)
		}
		if n := h.audits(exec.ID, ActionStepErrorRouted); n != 0 {
			t.Fatalf("cancel routed audits = %d", n)
		}
	})
}

// mixedYAML: soft (continue) -> next ; hard (plain) alone.
const mixedYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: route-mixed
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
          x: 1
    - id: soft
      type: flow.fail
      name: Soft
      onError: continue
      with:
        code: soft.fail
    - id: next
      type: flow.stop
      name: Next
      with:
        status: success
    - id: hard
      type: flow.fail
      name: Hard
      with:
        code: hard.fail
    - id: tail
      type: flow.stop
      name: Tail
      with:
        status: success
  edges:
    - from: seed.result
      to: soft.input
    - from: seed.result
      to: hard.input
    - from: soft.result
      to: next.input
    - from: hard.result
      to: tail.input
`

func TestMemoryErrorRouting(t *testing.T) {
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	runRoutingSuite(t, routeHarness{t: t, ctx: context.Background(), scope: scope, fresh: func() Store { return NewMemory() }})
}

func TestPostgresErrorRouting(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
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
	ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
	scope, err := isolation.Authorize(ws, userID)
	if err != nil {
		t.Fatal(err)
	}
	store := NewPostgres(app)
	runRoutingSuite(t, routeHarness{t: t, ctx: ctx, store: store, scope: scope})

	t.Run("indeterminate is never routed", func(t *testing.T) {
		src := strings.Replace(sshThenStopYAML, "      type: ssh.run\n      name: Run\n", "      type: ssh.run\n      name: Run\n      onError: continue\n", 1)
		exec := startGraph(t, ctx, store, scope, src)
		claimNode(t, ctx, store, scope, time.Now().UTC().Add(time.Second), "run")
		if n, err := store.RecoverExpiredLeases(ctx, scope, time.Now().UTC().Add(2*time.Minute)); err != nil || n < 1 {
			t.Fatalf("recover n=%d err=%v", n, err)
		}
		assertRun(t, ctx, store, scope, exec.ID, ExecutionIndeterminate)
		run := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "run")
		if run.Status != ExecutionIndeterminate || run.ErrorHandling != "" {
			t.Fatalf("run step = %s %q", run.Status, run.ErrorHandling)
		}
		assertSkipReason(t, ctx, store, scope, exec.ID, "next", SkipUpstreamIndeterminate)
		if n := len(closeAudits(t, ctx, store, scope, ActionStepErrorRouted, exec.ID)); n != 0 {
			t.Fatalf("lease loss routed audits = %d", n)
		}
	})
}
