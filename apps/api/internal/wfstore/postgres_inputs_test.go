package wfstore

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestPostgresResolveInputs(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
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
	now := func() time.Time { return time.Now().UTC().Add(time.Second) }

	t.Run("data chain and the untaken branch", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, dataChainYAML)
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "seed"))
		mapped := claimNode(t, ctx, store, scope, now(), "mapped")
		assertObject(t, mapped.Inputs["input"], "status", "ready")
		finishCore(t, ctx, store, scope, now(), mapped)
		checked := claimNode(t, ctx, store, scope, now(), "checked")
		assertObject(t, checked.Inputs["value"], "status", "ready")
		finishCore(t, ctx, store, scope, now(), checked)
		gate := claimNode(t, ctx, store, scope, now(), "gate")
		assertObject(t, gate.Inputs["value"], "status", "ready")
		finishCore(t, ctx, store, scope, now(), gate)
		stored := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "gate")
		if _, ok := stored.Output["false"]; !ok || stored.Output["false"] != nil {
			t.Fatalf("condition false port %#v", stored.Output)
		}
		yes := claimNode(t, ctx, store, scope, now(), "yes")
		assertObject(t, yes.Inputs["input"], "status", "ready")
		if _, ok := yes.Inputs["false"]; ok {
			t.Fatal("false key flowed")
		}
		for _, v := range yes.Inputs {
			if v == nil {
				t.Fatal("null input")
			}
		}
		assertNode(t, ctx, store, scope, exec.ID, "no", ExecutionSkipped, JobSkipped)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("if else leaves the untaken key absent", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, ifElseYAML)
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "seed"))
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "gate"))
		yes := claimNode(t, ctx, store, scope, now(), "yes")
		assertObject(t, yes.Inputs["input"], "status", "ready")
		if _, ok := yes.Inputs["false"]; ok {
			t.Fatal("false key flowed")
		}
		for _, v := range yes.Inputs {
			if v == nil {
				t.Fatal("null input")
			}
		}
		assertNode(t, ctx, store, scope, exec.ID, "no", ExecutionSkipped, JobSkipped)
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("retry uses the succeeded attempt", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, setThenMapYAML)
		seed := claimNode(t, ctx, store, scope, now(), "seed")
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: seed.Job.ID, WorkerID: "edge-worker", FencingToken: seed.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now(), exec.ID, seed.Step.ID); err != nil {
			t.Fatal(err)
		}
		again := claimNode(t, ctx, store, scope, now(), "seed")
		completeJob(t, ctx, store, scope, now(), again, map[string]any{"result": map[string]any{"status": "second"}})
		mapped := claimNode(t, ctx, store, scope, now(), "mapped")
		assertObject(t, mapped.Inputs["input"], "status", "second")
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("approval passes its input after a restart", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, approvalThenMapYAML)
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "seed"))
		gate := claimNode(t, ctx, store, scope, now(), "gate")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: gate.Job.ID, AvailableAt: now().Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ResumeWait(ctx, scope, now(), ResumeWaitInput{JobID: gate.Job.ID, Port: "approved"}); err != nil {
			t.Fatal(err)
		}
		restarted := NewPostgres(app)
		after := claimNode(t, ctx, restarted, scope, now(), "after")
		assertObject(t, after.Inputs["input"], "ticket", "CHG-1")
		if _, ok := after.Inputs["decision"]; ok {
			t.Fatal("decision flowed")
		}
		stored := stepByNode(t, listSteps(t, ctx, restarted, scope, exec.ID), "gate")
		if stored.Output["port"] != "approved" || stored.Output["decision"] != "approved" {
			t.Fatalf("gate output %#v", stored.Output)
		}
		if _, err := restarted.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("delay passes its input after a restart", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, delayThenMapYAML)
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "seed"))
		wait := claimNode(t, ctx, store, scope, now(), "wait")
		if _, err := store.WaitJob(ctx, scope, now(), WaitJobInput{JobID: wait.Job.ID, AvailableAt: now().Add(-time.Minute)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RecoverExpiredLeases(ctx, scope, now()); err != nil {
			t.Fatal(err)
		}
		restarted := NewPostgres(app)
		after := claimNode(t, ctx, restarted, scope, now(), "after")
		assertObject(t, after.Inputs["input"], "ticket", "CHG-1")
		stored := stepByNode(t, listSteps(t, ctx, restarted, scope, exec.ID), "wait")
		if stored.Output["port"] != "result" || stored.Output["decision"] != "result" {
			t.Fatalf("delay output %#v", stored.Output)
		}
		if _, ok := stored.Output["ticket"]; ok {
			t.Fatal("delay stored the passthrough")
		}
		if _, err := restarted.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("http token is redacted before it is wired", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, httpThenMapYAML)
		call := claimNode(t, ctx, store, scope, now(), "call")
		completeJob(t, ctx, store, scope, now(), call, map[string]any{
			"result": map[string]any{"token": echoMarker, "name": "ok"},
		})
		stored := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "call")
		mapped := claimNode(t, ctx, store, scope, now(), "mapped")
		assertRedacted(t, stored.Output)
		assertRedacted(t, mapped.Inputs)
		got, _ := mapped.Inputs["input"].(map[string]any)
		if got["name"] != "ok" || got["token"] != redactedMarker {
			t.Fatal("redacted input lost the safe fields")
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("or join keeps an optional missed port", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, conditionOrJoinYAML)
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "seed"))
		finishCore(t, ctx, store, scope, now(), claimNode(t, ctx, store, scope, now(), "gate"))
		join := claimNode(t, ctx, store, scope, now(), "join")
		assertObject(t, join.Inputs["manifests"], "ready", true)
		if _, ok := join.Inputs["parameters"]; ok {
			t.Fatal("parameters key present")
		}
		if !hasSkip(join.SkippedInputs, "parameters", "gate.false") {
			t.Fatalf("skipped %#v", join.SkippedInputs)
		}
		out := workflow.EvaluateStep(join.Step.NodeType, join.Step.Input, join.Inputs, toPorts(join.SkippedInputs))
		if out.Code == workflow.CodeUpstreamSkipped {
			t.Fatal("optional port failed upstream-skipped")
		}
		if _, err := store.CancelExecution(ctx, scope, now(), exec.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("upstream skipped on a claimable join", func(t *testing.T) {
		exec := startGraph(t, ctx, store, scope, upstreamSkipYAML)
		done := map[string]bool{}
		for len(done) < 2 {
			got := claimNode(t, ctx, store, scope, now(), "")
			switch got.Step.NodeID {
			case "kept":
				completeJob(t, ctx, store, scope, now(), got, map[string]any{"stdout": "demo", "exitCode": 0})
			case "side":
				completeJob(t, ctx, store, scope, now(), got, map[string]any{"result": map[string]any{"side": "yes"}})
			default:
				t.Fatalf("claimed %s", got.Step.NodeID)
			}
			done[got.Step.NodeID] = true
		}
		stamp := now()
		if _, err := admin.Exec(ctx, `
			UPDATE execution_edges
			SET required = false, resolved = true, satisfied = false
			WHERE workspace_id = $1::uuid AND execution_id = $2::uuid AND to_node = 'join' AND from_node = 'hub'
		`, ws, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `
			INSERT INTO execution_edges (
				workspace_id, execution_id, from_node, from_port, to_node, to_port, required, resolved, satisfied
			) VALUES ($1::uuid, $2::uuid, 'side', 'result', 'join', 'extra', false, true, true)
		`, ws, exec.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := admin.Exec(ctx, `
			UPDATE execution_steps
			SET status = 'queued', unresolved_incoming = 0, updated_at = $3
			WHERE workspace_id = $1::uuid AND execution_id = $2::uuid AND node_id = 'join'
		`, ws, exec.ID, stamp); err != nil {
			t.Fatal(err)
		}
		tag, err := admin.Exec(ctx, `
			UPDATE execution_jobs j
			SET status = 'canceled', updated_at = $3
			FROM execution_steps s
			WHERE j.workspace_id = s.workspace_id AND j.execution_step_id = s.id
			  AND j.workspace_id = $1::uuid AND s.execution_id = $2::uuid AND s.node_id = 'hub' AND j.status = 'queued'
		`, ws, exec.ID, stamp)
		if err != nil || tag.RowsAffected() != 1 {
			t.Fatalf("cancel hub: %v rows %d", err, tag.RowsAffected())
		}
		tag, err = admin.Exec(ctx, `
			UPDATE execution_jobs j
			SET status = 'queued', available_at = $3, worker_id = NULL, lease_expires_at = NULL, updated_at = $3
			FROM execution_steps s
			WHERE j.workspace_id = s.workspace_id AND j.execution_step_id = s.id
			  AND j.workspace_id = $1::uuid AND s.execution_id = $2::uuid AND s.node_id = 'join'
		`, ws, exec.ID, stamp)
		if err != nil || tag.RowsAffected() != 1 {
			t.Fatalf("queue join: %v rows %d", err, tag.RowsAffected())
		}
		join := claimNode(t, ctx, store, scope, now(), "join")
		if _, ok := join.Inputs["input"]; ok {
			t.Fatalf("input key present %#v", join.Inputs)
		}
		for _, v := range join.Inputs {
			if v == nil {
				t.Fatal("null input")
			}
		}
		assertObject(t, join.Inputs["extra"], "side", "yes")
		if !hasSkip(join.SkippedInputs, "input", "hub.result") {
			t.Fatalf("skipped %#v", join.SkippedInputs)
		}
		out := workflow.EvaluateStep(join.Step.NodeType, join.Step.Input, join.Inputs, toPorts(join.SkippedInputs))
		if !out.Fail || out.Code != workflow.CodeUpstreamSkipped {
			t.Fatalf("outcome %+v", out)
		}
		if _, err := store.FailJob(ctx, scope, now(), JobActionInput{
			JobID: join.Job.ID, WorkerID: "edge-worker", FencingToken: join.Job.FencingToken,
			Error: map[string]any{"code": out.Code, "message": out.Message},
		}); err != nil {
			t.Fatal(err)
		}
		failed := stepByNode(t, listSteps(t, ctx, store, scope, exec.ID), "join")
		if failed.Error["code"] != workflow.CodeUpstreamSkipped {
			t.Fatalf("step error %#v", failed.Error)
		}
	})
}

func finishCore(t *testing.T, ctx context.Context, store *Postgres, scope isolation.Scope, now time.Time, claimed DispatchResult) {
	t.Helper()
	out := workflow.EvaluateStep(claimed.Step.NodeType, claimed.Step.Input, claimed.Inputs, toPorts(claimed.SkippedInputs))
	if out.Fail {
		t.Fatalf("%s %s: %s", claimed.Step.NodeID, out.Code, out.Message)
	}
	completeJob(t, ctx, store, scope, now, claimed, out.Output)
}

func toPorts(in []SkippedInput) []workflow.SkippedPort {
	if len(in) == 0 {
		return nil
	}
	out := make([]workflow.SkippedPort, len(in))
	for i, s := range in {
		out[i] = workflow.SkippedPort{Port: s.Port, From: s.From}
	}
	return out
}

func hasSkip(in []SkippedInput, port, from string) bool {
	for _, s := range in {
		if s.Port == port && s.From == from {
			return true
		}
	}
	return false
}

func assertObject(t *testing.T, v any, key string, want any) {
	t.Helper()
	got, ok := v.(map[string]any)
	if !ok || got[key] != want {
		raw, _ := json.Marshal(v)
		t.Fatalf("input %s = %s", key, raw)
	}
}

const dataChainYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: data-chain
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
          status: ready
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          status: status
    - id: checked
      type: data.validate
      name: Check
      with:
        schema:
          type: object
          properties:
            status: {type: string}
          required: [status]
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: eq
        path: status
        compare: ready
    - id: yes
      type: data.map
      name: Yes
      with:
        mapping:
          status: status
    - id: no
      type: data.map
      name: No
      with:
        mapping:
          status: status
  edges:
    - from: seed.result
      to: mapped.input
    - from: mapped.result
      to: checked.value
    - from: checked.result
      to: gate.value
    - from: gate.true
      to: yes.input
    - from: gate.false
      to: no.input
`

const delayThenMapYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: delay-then-map
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
    - id: wait
      type: flow.delay
      name: Wait
      with:
        duration: PT1S
    - id: after
      type: data.map
      name: After
      with:
        mapping:
          ticket: ticket
  edges:
    - from: seed.result
      to: wait.input
    - from: wait.result
      to: after.input
`

const upstreamSkipYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: upstream-skip
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: kept
      type: ssh.run
      name: Kept
      with:
        sshTargetId: 11111111-1111-4111-8111-111111111111
        commandProfileId: 22222222-2222-4222-8222-222222222222
    - id: side
      type: data.set
      name: Side
      with:
        value:
          side: "yes"
    - id: hub
      type: kubernetes.apply
      name: Hub
      join: any
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: demo
    - id: join
      type: data.map
      name: Join
      with:
        mapping:
          ok: ok
  edges:
    - from: kept.stdout
      to: hub.manifests
    - from: side.result
      to: hub.parameters
    - from: hub.result
      to: join.input
`
