package wfstore

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
)

// #649 S3: workspace error workflow, both stores.

const errorTargetYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: on-error
spec:
  triggers:
    - id: on-error
      type: error
  nodes:
    - id: note
      type: data.set
      name: Note
      with:
        value:
          seen: true
`

var errorPayloadKeys = []string{"actorId", "code", "executionId", "message", "nodeId", "reason", "triggerType", "workflowId", "workflowName", "workflowVersion", "workflowVersionId"}

type ewHarness struct {
	routeHarness
	ew      ErrorWorkflowStore
	setGate func(ErrorWorkflowGate)
}

// allowGate stands in for approval.ErrorWorkflowGate when policy allows.
func allowGate(context.Context, pgx.Tx, isolation.Scope, Version) string { return "" }

func (h ewHarness) publish(src string) (Workflow, Version) {
	h.t.Helper()
	src = strings.Replace(src, "\n  name: ", "\n  name: n"+newID()[:8]+"-", 1)
	n := mustNormalize(h.t, src)
	wf, draft, err := h.store.Create(h.ctx, h.scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
	if err != nil {
		h.t.Fatal(err)
	}
	wf, ver, err := h.store.Publish(h.ctx, h.scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision})
	if err != nil {
		h.t.Fatal(err)
	}
	return wf, ver
}

func (h ewHarness) setTarget() Workflow {
	h.t.Helper()
	wf, _ := h.publish(errorTargetYAML)
	if _, err := h.ew.SetErrorWorkflow(h.ctx, h.scope, wf.ID, AuditActor{DisplayName: "Ada Admin"}); err != nil {
		h.t.Fatal(err)
	}
	return wf
}

func (h ewHarness) startAs(src, trigger string) Execution {
	h.t.Helper()
	wf, ver := h.publish(src)
	exec, err := h.store.StartExecution(h.ctx, h.scope, wf.ID, StartInput{VersionID: ver.ID, TriggerType: trigger})
	if err != nil {
		h.t.Fatal(err)
	}
	return exec
}

// failBoom runs seed and fails boom with code.
func (h ewHarness) failBoom(exec Execution, code string) {
	h.t.Helper()
	h.complete(h.claimFor(exec.ID, "seed"), map[string]any{"result": map[string]any{"env": "staging"}})
	boom := h.claimFor(exec.ID, "boom")
	if _, err := h.store.FailJob(h.ctx, h.scope, h.now(), JobActionInput{
		JobID: boom.Job.ID, WorkerID: "route-worker", FencingToken: boom.Job.FencingToken,
		Error: map[string]any{"code": code, "message": "planned failure " + strings.Repeat("m", 400)},
	}); err != nil {
		h.t.Fatal(err)
	}
}

func (h ewHarness) events(execID, action string) []AuditEvent {
	h.t.Helper()
	got, err := h.store.ListAuditEvents(h.ctx, h.scope, AuditListFilter{Action: action, ResourceID: execID})
	if err != nil {
		h.t.Fatal(err)
	}
	return got
}

func (h ewHarness) child(parentID string) Execution {
	h.t.Helper()
	fired := h.events(parentID, ActionErrorWorkflowFired)
	if len(fired) != 1 {
		h.t.Fatalf("fired audits = %d", len(fired))
	}
	id, _ := fired[0].Details["errorExecutionId"].(string)
	child, err := h.store.GetExecutionByID(h.ctx, h.scope, id)
	if err != nil {
		h.t.Fatalf("child %q: %v", id, err)
	}
	return child
}

func (h ewHarness) assertSilent(execID string) {
	h.t.Helper()
	if n := len(h.events(execID, ActionErrorWorkflowFired)); n != 0 {
		h.t.Fatalf("fired = %d", n)
	}
	if n := len(h.events(execID, ActionErrorWorkflowSkipped)); n != 0 {
		h.t.Fatalf("skipped = %d", n)
	}
}

func (h ewHarness) assertSkipped(execID, reason string) {
	h.t.Helper()
	if n := len(h.events(execID, ActionErrorWorkflowFired)); n != 0 {
		h.t.Fatalf("fired = %d", n)
	}
	got := h.events(execID, ActionErrorWorkflowSkipped)
	if len(got) != 1 || got[0].Details["reason"] != reason {
		h.t.Fatalf("skipped = %+v, want reason %s", got, reason)
	}
}

func payloadKeys(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func runErrorWorkflowSuite(t *testing.T, mk func(t *testing.T) ewHarness) {
	t.Run("failed schedule run fires once with the capped payload", func(t *testing.T) {
		h := mk(t)
		target := h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "fixture.boom")
		if got := h.run(exec.ID); got.Status != ExecutionFailed {
			t.Fatalf("parent = %s", got.Status)
		}
		child := h.child(exec.ID)
		if child.ErrorParentID != exec.ID || child.WorkflowID != target.ID || child.RequestedBy != "" || ExecutionTriggerType(child) != TriggerError {
			t.Fatalf("child = %+v", child)
		}
		in := child.Input
		if got := payloadKeys(in); strings.Join(got, ",") != strings.Join(errorPayloadKeys, ",") {
			t.Fatalf("payload keys = %v", got)
		}
		if in["reason"] != ErrorReasonFailed || in["triggerType"] != "schedule" || in["executionId"] != exec.ID ||
			in["workflowId"] != exec.WorkflowID || in["workflowVersionId"] != exec.WorkflowVersionID ||
			in["nodeId"] != "boom" || in["code"] != "fixture.boom" || num(in["workflowVersion"]) != 1 {
			t.Fatalf("payload = %+v", in)
		}
		if msg, _ := in["message"].(string); len(msg) > 256 || !strings.HasPrefix(msg, "planned failure") {
			t.Fatalf("message len = %d", len(msg))
		}
		if strings.Contains(in["workflowName"].(string), "route-") == false {
			t.Fatalf("workflowName = %v", in["workflowName"])
		}
		// The error run itself failing never fires again (no chain).
		note := h.claimFor(child.ID, "note")
		if _, err := h.store.FailJob(h.ctx, h.scope, h.now(), JobActionInput{
			JobID: note.Job.ID, WorkerID: "route-worker", FencingToken: note.Job.FencingToken,
			Error: map[string]any{"code": "timeout", "message": "x"},
		}); err != nil {
			t.Fatal(err)
		}
		if got := h.run(child.ID); got.Status != ExecutionFailed {
			t.Fatalf("child = %s", got.Status)
		}
		h.assertSilent(child.ID)
		if n := len(h.events(exec.ID, ActionErrorWorkflowFired)); n != 1 {
			t.Fatalf("parent fired = %d", n)
		}
	})

	t.Run("api and webhook runs fire; manual runs never do", func(t *testing.T) {
		h := mk(t)
		h.setTarget()
		for _, trig := range []string{"api", "webhook"} {
			exec := h.startAs(routeYAML(""), trig)
			h.failBoom(exec, "fixture.boom")
			if got := h.child(exec.ID).Input["triggerType"]; got != trig {
				t.Fatalf("%s: triggerType = %v", trig, got)
			}
		}
		for _, trig := range []string{"", "manual"} {
			exec := h.startAs(routeYAML(""), trig)
			h.failBoom(exec, "fixture.boom")
			h.assertSilent(exec.ID)
		}
	})

	t.Run("indeterminate fires with reason indeterminate", func(t *testing.T) {
		h := mk(t)
		h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		h.claimFor(exec.ID, "seed")
		if _, err := h.store.RecoverExpiredLeases(h.ctx, h.scope, time.Now().UTC().Add(5*time.Minute)); err != nil {
			t.Fatal(err)
		}
		if got := h.run(exec.ID); got.Status != ExecutionIndeterminate {
			t.Fatalf("parent = %s", got.Status)
		}
		in := h.child(exec.ID).Input
		if in["reason"] != ErrorReasonIndeterminate || in["nodeId"] != "seed" {
			t.Fatalf("payload = %+v", in)
		}
	})

	t.Run("system, security, authz and policy codes never fire", func(t *testing.T) {
		h := mk(t)
		h.setTarget()
		for _, code := range []string{"policy-denied", "rbac-denied", "egress-denied", "emergency-stopped", "brand-new-code", "other.reason"} {
			exec := h.startAs(routeYAML(""), "schedule")
			h.failBoom(exec, code)
			h.assertSkipped(exec.ID, ErrorSkipCodeNotEligible)
		}
	})

	t.Run("canceled and succeededWithErrors never fire", func(t *testing.T) {
		h := mk(t)
		h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		if _, err := h.store.CancelExecution(h.ctx, h.scope, h.now(), exec.ID); err != nil {
			t.Fatal(err)
		}
		h.assertSilent(exec.ID)
		exec = h.startAs(routeYAML("continue"), "schedule")
		h.failBoom(exec, "fixture.boom")
		h.complete(h.claimFor(exec.ID, "after"), map[string]any{"result": map[string]any{}})
		if got := h.run(exec.ID); got.Status != ExecutionSucceededWithErrors {
			t.Fatalf("parent = %s", got.Status)
		}
		h.assertSilent(exec.ID)
	})

	t.Run("no error workflow set: nothing fires or is audited", func(t *testing.T) {
		h := mk(t)
		if _, err := h.ew.ClearErrorWorkflow(h.ctx, h.scope, AuditActor{DisplayName: "Ada Admin"}); err != nil {
			t.Fatal(err)
		}
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "fixture.boom")
		h.assertSilent(exec.ID)
	})

	t.Run("deleted target is skipped and audited", func(t *testing.T) {
		h := mk(t)
		target := h.setTarget()
		if _, err := h.store.Delete(h.ctx, h.scope, target.ID); err != nil {
			t.Fatal(err)
		}
		set, ok, err := h.ew.GetErrorWorkflow(h.ctx, h.scope)
		if err != nil || !ok || set.WorkflowID != target.ID {
			t.Fatalf("reference must stay: %+v %v %v", set, ok, err)
		}
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "fixture.boom")
		h.assertSkipped(exec.ID, ErrorSkipTargetDeleted)
	})

	t.Run("unwired policy gate fails closed", func(t *testing.T) {
		h := mk(t)
		h.setGate(nil)
		h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "fixture.boom")
		h.assertSkipped(exec.ID, ErrorSkipPolicyUnavailable)
	})

	t.Run("policy-denied target is skipped and audited", func(t *testing.T) {
		h := mk(t)
		h.setGate(func(context.Context, pgx.Tx, isolation.Scope, Version) string { return ErrorSkipPolicyDenied })
		h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "fixture.boom")
		h.assertSkipped(exec.ID, ErrorSkipPolicyDenied)
	})

	t.Run("operator-retried run never fires", func(t *testing.T) {
		h := mk(t)
		h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "policy-denied")
		h.assertSkipped(exec.ID, ErrorSkipCodeNotEligible)
		boom, _ := h.step(exec.ID, "boom")
		if _, err := h.store.RetryStep(h.ctx, h.scope, h.now(), exec.ID, boom.ID); err != nil {
			t.Fatalf("retry: %v", err)
		}
		again := h.claimFor(exec.ID, "boom")
		if _, err := h.store.FailJob(h.ctx, h.scope, h.now(), JobActionInput{
			JobID: again.Job.ID, WorkerID: "route-worker", FencingToken: again.Job.FencingToken,
			Error: map[string]any{"code": "fixture.boom", "message": "again"},
		}); err != nil {
			t.Fatal(err)
		}
		if got := h.run(exec.ID); got.Status != ExecutionFailed {
			t.Fatalf("parent = %s", got.Status)
		}
		if n := len(h.events(exec.ID, ActionErrorWorkflowFired)); n != 0 {
			t.Fatalf("fired after operator retry = %d", n)
		}
	})

	t.Run("set and clear: target rules, audit display name and UUID", func(t *testing.T) {
		h := mk(t)
		manual, _ := h.publish(routeYAML(""))
		if _, err := h.ew.SetErrorWorkflow(h.ctx, h.scope, manual.ID, AuditActor{DisplayName: "Ada"}); !errors.Is(err, ErrErrorWorkflowTarget) {
			t.Fatalf("manual target = %v", err)
		}
		n := mustNormalize(t, strings.Replace(errorTargetYAML, "name: on-error", "name: on-error-draft", 1))
		draft, _, err := h.store.Create(h.ctx, h.scope, CreateInput{NormalizedYAML: n.NormalizedYAML, Digest: n.Digest, Summary: n.Summary})
		if err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{draft.ID, "99999999-9999-4999-8999-999999999999", "not-a-uuid", ""} {
			if _, err := h.ew.SetErrorWorkflow(h.ctx, h.scope, id, AuditActor{DisplayName: "Ada"}); !errors.Is(err, ErrErrorWorkflowTarget) {
				t.Fatalf("target %q = %v", id, err)
			}
		}
		sys, _ := isolation.AuthorizeSystem(h.scope.WorkspaceID())
		if _, err := h.ew.SetErrorWorkflow(h.ctx, sys, manual.ID, AuditActor{}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("system scope set = %v", err)
		}
		if _, err := h.ew.ClearErrorWorkflow(h.ctx, sys, AuditActor{}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("system scope clear = %v", err)
		}
		target := h.setTarget()
		sets := h.events(h.scope.WorkspaceID(), ActionErrorWorkflowSet)
		last := sets[0]
		for _, ev := range sets {
			if ev.OccurredAt.After(last.OccurredAt) {
				last = ev
			}
		}
		if last.ActorID != h.scope.ActorID() || last.Details["actorDisplayName"] != "Ada Admin" || last.Details["actorId"] != h.scope.ActorID() || last.Details["workflowId"] != target.ID {
			t.Fatalf("set audit = %+v", last)
		}
		if ok, err := h.ew.ClearErrorWorkflow(h.ctx, h.scope, AuditActor{DisplayName: "Ada Admin"}); err != nil || !ok {
			t.Fatalf("clear = %v %v", ok, err)
		}
		if ok, err := h.ew.ClearErrorWorkflow(h.ctx, h.scope, AuditActor{DisplayName: "Ada Admin"}); err != nil || ok {
			t.Fatalf("second clear = %v %v", ok, err)
		}
		if _, ok, _ := h.ew.GetErrorWorkflow(h.ctx, h.scope); ok {
			t.Fatal("still set after clear")
		}
	})

	t.Run("only the engine starts an error workflow", func(t *testing.T) {
		h := mk(t)
		wf, ver := h.publish(errorTargetYAML)
		for _, trig := range []string{"", "manual", "api", "schedule", "webhook"} {
			if _, err := h.store.StartExecution(h.ctx, h.scope, wf.ID, StartInput{VersionID: ver.ID, TriggerType: trig}); !errors.Is(err, ErrInvalid) {
				t.Fatalf("start %q = %v", trig, err)
			}
		}
		other, over := h.publish(routeYAML(""))
		if _, err := h.store.StartExecution(h.ctx, h.scope, other.ID, StartInput{VersionID: over.ID, TriggerType: TriggerError}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("trigger error = %v", err)
		}
	})
}

func TestMemoryErrorWorkflow649(t *testing.T) {
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	runErrorWorkflowSuite(t, func(t *testing.T) ewHarness {
		m := NewMemory()
		m.SetErrorWorkflowGate(allowGate)
		return ewHarness{routeHarness: routeHarness{t: t, ctx: context.Background(), scope: scope, store: m}, ew: m, setGate: m.SetErrorWorkflowGate}
	})
}

func TestPostgresErrorWorkflow649(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
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
	SetErrorWorkflowGate(allowGate)
	t.Cleanup(func() { SetErrorWorkflowGate(nil) })
	runErrorWorkflowSuite(t, func(t *testing.T) ewHarness {
		ws, _, userID := seedWorkflowWorkspaces(t, ctx, admin)
		scope, err := isolation.Authorize(ws, userID)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { SetErrorWorkflowGate(allowGate) })
		return ewHarness{routeHarness: routeHarness{t: t, ctx: ctx, scope: scope, store: store}, ew: store, setGate: SetErrorWorkflowGate}
	})

	t.Run("cross-workspace target is refused; RLS hides the other setting", func(t *testing.T) {
		wsA, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
		scopeA, _ := isolation.Authorize(wsA, userID)
		scopeB, _ := isolation.Authorize(wsB, userID)
		hB := ewHarness{routeHarness: routeHarness{t: t, ctx: ctx, scope: scopeB, store: store}, ew: store}
		inB, _ := hB.publish(errorTargetYAML)
		if _, err := store.SetErrorWorkflow(ctx, scopeA, inB.ID, AuditActor{DisplayName: "Ada"}); !errors.Is(err, ErrErrorWorkflowTarget) {
			t.Fatalf("cross-workspace set = %v", err)
		}
		// The composite FK refuses it even below the store.
		if _, err := admin.Exec(ctx, `UPDATE workspaces SET error_workflow_id = $2::uuid WHERE id = $1::uuid`, wsA, inB.ID); err == nil {
			t.Fatal("FK allowed a cross-workspace error workflow")
		}
		hB.setTarget()
		if _, ok, err := store.GetErrorWorkflow(ctx, scopeA); err != nil || ok {
			t.Fatalf("A sees B's setting: %v %v", ok, err)
		}
	})

	t.Run("fire-once and same-workspace parent are enforced by the schema", func(t *testing.T) {
		ws, wsB, userID := seedWorkflowWorkspaces(t, ctx, admin)
		scope, _ := isolation.Authorize(ws, userID)
		h := ewHarness{routeHarness: routeHarness{t: t, ctx: ctx, scope: scope, store: store}, ew: store}
		h.setTarget()
		exec := h.startAs(routeYAML(""), "schedule")
		h.failBoom(exec, "fixture.boom")
		child := h.child(exec.ID)
		dup := `INSERT INTO executions (workspace_id, workflow_id, workflow_version_id, workflow_digest, status,
		            input_redacted, policy_snapshot, retention_until, error_parent_id)
		        SELECT $3::uuid, workflow_id, workflow_version_id, workflow_digest, 'queued', '{}', '{}', now(), $2::uuid
		          FROM executions WHERE id = $1::uuid`
		if _, err := admin.Exec(ctx, dup, child.ID, exec.ID, ws); err == nil {
			t.Fatal("second error run for one parent was accepted")
		}
		if _, err := admin.Exec(ctx, dup, child.ID, exec.ID, wsB); err == nil {
			t.Fatal("cross-workspace error parent was accepted")
		}
		var fired bool
		if err := admin.QueryRow(ctx, `SELECT error_fired_at IS NOT NULL FROM executions WHERE id = $1::uuid`, exec.ID).Scan(&fired); err != nil || !fired {
			t.Fatalf("error_fired_at = %v %v", fired, err)
		}
	})
}
