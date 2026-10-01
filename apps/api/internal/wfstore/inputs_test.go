package wfstore

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestResolveInputsRule(t *testing.T) {
	t.Run("null is omitted and false and empty string flow", func(t *testing.T) {
		snaps := map[string]succeededSnap{
			"gate": {NodeType: "flow.condition", Output: map[string]any{
				"true":  map[string]any{"status": "ready"},
				"false": nil,
				"port":  "true",
			}},
			"run":  {NodeType: "ssh.run", Output: map[string]any{"stdout": ""}},
			"flag": {NodeType: "data.set", Output: map[string]any{"result": false}},
		}
		edges := []execEdge{
			{FromNode: "gate", FromPort: "false", ToNode: "no", ToPort: "input", Satisfied: true, Resolved: true},
			{FromNode: "run", FromPort: "stdout", ToNode: "next", ToPort: "input", Satisfied: true, Resolved: true},
			{FromNode: "flag", FromPort: "result", ToNode: "bit", ToPort: "input", Satisfied: true, Resolved: true},
		}
		noInputs, noSkip := resolveInputs("no", edges, snaps)
		if noInputs != nil || noSkip != nil {
			t.Fatalf("null port flowed: %#v %#v", noInputs, noSkip)
		}
		next, _ := resolveInputs("next", edges, snaps)
		if next["input"] != "" {
			t.Fatalf("empty string = %#v", next["input"])
		}
		bit, _ := resolveInputs("bit", edges, snaps)
		if bit["input"] != false {
			t.Fatalf("false = %#v", bit["input"])
		}
	})

	t.Run("unsatisfied edge is absent", func(t *testing.T) {
		edges := []execEdge{{
			FromNode: "left", FromPort: "result", ToNode: "map", ToPort: "input", Resolved: true,
		}}
		inputs, skipped := resolveInputs("map", edges, map[string]succeededSnap{
			"left": {NodeType: "data.set", Output: map[string]any{"result": nil}},
		})
		if inputs != nil {
			t.Fatalf("unsatisfied produced %#v", inputs)
		}
		if len(skipped) != 1 || skipped[0].Port != "input" || skipped[0].From != "left.result" {
			t.Fatalf("skipped %#v", skipped)
		}
	})

	t.Run("wait nodes pass their input not their output", func(t *testing.T) {
		snaps := map[string]succeededSnap{
			"seed": {NodeType: "data.set", Output: map[string]any{"result": map[string]any{"ticket": "CHG-1"}}},
			"wait": {NodeType: "flow.delay", Output: map[string]any{"port": "result", "decision": "result"}},
			"gate": {NodeType: "flow.approval", Output: map[string]any{"port": "approved", "decision": "approved"}},
		}
		edges := []execEdge{
			{FromNode: "seed", FromPort: "result", ToNode: "wait", ToPort: "input", Satisfied: true, Resolved: true},
			{FromNode: "wait", FromPort: "result", ToNode: "gate", ToPort: "request", Satisfied: true, Resolved: true},
			{FromNode: "gate", FromPort: "approved", ToNode: "after", ToPort: "input", Satisfied: true, Resolved: true},
		}
		inputs, skipped := resolveInputs("after", edges, snaps)
		if skipped != nil {
			t.Fatalf("skipped %#v", skipped)
		}
		got, _ := inputs["input"].(map[string]any)
		if got["ticket"] != "CHG-1" {
			t.Fatalf("passthrough %#v", inputs["input"])
		}
		if _, ok := inputs["port"]; ok || inputs["decision"] != nil {
			t.Fatalf("gate output flowed %#v", inputs)
		}
		got["ticket"] = "mutated"
		stored, _ := snaps["seed"].Output["result"].(map[string]any)
		if stored["ticket"] != "CHG-1" {
			t.Fatal("resolved input aliased the stored output")
		}
	})

	t.Run("scalar through a delay is wrapped", func(t *testing.T) {
		snaps := map[string]succeededSnap{
			"run":  {NodeType: "ssh.run", Output: map[string]any{"stdout": "demo"}},
			"wait": {NodeType: "flow.delay", Output: map[string]any{"port": "result", "decision": "result"}},
		}
		edges := []execEdge{
			{FromNode: "run", FromPort: "stdout", ToNode: "wait", ToPort: "input", Satisfied: true, Resolved: true},
			{FromNode: "wait", FromPort: "result", ToNode: "mapped", ToPort: "input", Satisfied: true, Resolved: true},
		}
		inputs, skipped := resolveInputs("mapped", edges, snaps)
		if skipped != nil {
			t.Fatalf("skipped %#v", skipped)
		}
		got, _ := inputs["input"].(map[string]any)
		if got["value"] != "demo" || len(got) != 1 {
			t.Fatalf("wrapped %#v", inputs["input"])
		}
		out := workflow.EvaluateStep("data.map", map[string]any{"mapping": map[string]any{"value": "value"}}, inputs, nil)
		if out.Fail || out.Code == workflow.CodeRequiredInput {
			t.Fatalf("map %+v", out)
		}
		result, _ := out.Output["result"].(map[string]any)
		if result["value"] != "demo" {
			t.Fatalf("map result %#v", out.Output)
		}
	})

	t.Run("unwired delay input is an empty object", func(t *testing.T) {
		snaps := map[string]succeededSnap{
			"wait": {NodeType: "flow.delay", Output: map[string]any{"port": "result", "decision": "result"}},
		}
		edges := []execEdge{{
			FromNode: "wait", FromPort: "result", ToNode: "mapped", ToPort: "input", Satisfied: true, Resolved: true,
		}}
		inputs, skipped := resolveInputs("mapped", edges, snaps)
		if skipped != nil {
			t.Fatalf("skipped %#v", skipped)
		}
		assertEmptyObject(t, inputs["input"])
		out := workflow.EvaluateStep("data.map", map[string]any{"mapping": map[string]any{"value": "value"}}, inputs, nil)
		if out.Code == workflow.CodeRequiredInput {
			t.Fatalf("required-input %+v", out)
		}
	})

	t.Run("unwired approval request is an empty object", func(t *testing.T) {
		snaps := map[string]succeededSnap{
			"gate": {NodeType: "flow.approval", Output: map[string]any{"port": "approved", "decision": "approved"}},
		}
		edges := []execEdge{{
			FromNode: "gate", FromPort: "approved", ToNode: "mapped", ToPort: "input", Satisfied: true, Resolved: true,
		}}
		inputs, skipped := resolveInputs("mapped", edges, snaps)
		if skipped != nil {
			t.Fatalf("skipped %#v", skipped)
		}
		assertEmptyObject(t, inputs["input"])
		if _, ok := inputs["decision"]; ok {
			t.Fatal("decision flowed")
		}
	})

	t.Run("redacted secret keys pass through a delay", func(t *testing.T) {
		inputs, skipped := resolveInputs("checked", echoDelayEdges(), echoDelaySnaps(map[string]any{
			"token": redactedMarker, "authorization": redactedMarker,
		}))
		if skipped != nil {
			t.Fatalf("skipped %#v", skipped)
		}
		got, _ := inputs["value"].(map[string]any)
		if got["token"] != redactedMarker || got["authorization"] != redactedMarker {
			t.Fatalf("validate input %#v", inputs["value"])
		}
	})

	t.Run("oversized delay passthrough names the delay", func(t *testing.T) {
		inputs, skipped := resolveInputs("checked", echoDelayEdges(), echoDelaySnaps(map[string]any{
			"body": strings.Repeat("a", 20<<10),
		}))
		if _, ok := inputs["value"]; ok {
			t.Fatal("oversized value was forwarded")
		}
		if len(skipped) != 1 || skipped[0].Code != workflow.CodeOutputTooLarge || !strings.Contains(skipped[0].Message, "wait") {
			t.Fatalf("skipped %#v", skipped)
		}
		out := workflow.EvaluateStep("data.validate", map[string]any{"schema": map[string]any{"type": "object"}}, inputs, portsOf(skipped))
		if out.Code != workflow.CodeOutputTooLarge || !strings.Contains(out.Message, "wait") {
			t.Fatalf("%+v", out)
		}
	})
}

func TestUpstreamNodeIDs(t *testing.T) {
	edges := []execEdge{
		{FromNode: "seed", FromPort: "stdout", ToNode: "wait", ToPort: "input"},
		{FromNode: "wait", FromPort: "result", ToNode: "mapped", ToPort: "input"},
		{FromNode: "other", FromPort: "result", ToNode: "side", ToPort: "input"},
	}
	if ids := upstreamNodeIDs("seed", edges); ids != nil {
		t.Fatalf("root ids %#v", ids)
	}
	got := upstreamNodeIDs("mapped", edges)
	if len(got) != 2 || got[0] != "seed" || got[1] != "wait" {
		t.Fatalf("closure %#v", got)
	}
	direct := upstreamNodeIDs("wait", edges)
	if len(direct) != 1 || direct[0] != "seed" {
		t.Fatalf("direct %#v", direct)
	}
}

func TestUpstreamSkippedGuard(t *testing.T) {
	out := workflow.EvaluateStep("data.map", map[string]any{
		"mapping": map[string]any{"status": "status"},
	}, nil, []workflow.SkippedPort{{Port: "input", From: "hub.result"}})
	if !out.Fail || out.Code != workflow.CodeUpstreamSkipped {
		t.Fatalf("%+v", out)
	}
	optional := workflow.EvaluateStep("kubernetes.apply", map[string]any{
		"clusterTargetId": "11111111-1111-4111-8111-111111111111",
		"namespace":       "demo",
	}, nil, []workflow.SkippedPort{{Port: "parameters", From: "side.result"}})
	if optional.Code == workflow.CodeUpstreamSkipped {
		t.Fatalf("optional port %+v", optional)
	}
}

func TestMemoryResolveInputs(t *testing.T) {
	ctx := context.Background()
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Add(time.Second)

	t.Run("set reaches map", func(t *testing.T) {
		store := NewMemory()
		exec := startMemory(t, ctx, store, scope, setThenMapYAML)
		seed := claimMemory(t, ctx, store, scope, now, "seed")
		if seed.Inputs != nil {
			t.Fatalf("seed inputs %#v", seed.Inputs)
		}
		completeMemory(t, ctx, store, scope, now, seed, map[string]any{"result": map[string]any{"status": "ready"}})
		mapped := claimMemory(t, ctx, store, scope, now, "mapped")
		got, _ := mapped.Inputs["input"].(map[string]any)
		if got["status"] != "ready" {
			t.Fatalf("map inputs %#v", mapped.Inputs)
		}
		_ = exec
	})

	t.Run("untaken branch key is absent", func(t *testing.T) {
		store := NewMemory()
		exec := startMemory(t, ctx, store, scope, ifElseYAML)
		seed := claimMemory(t, ctx, store, scope, now, "seed")
		completeMemory(t, ctx, store, scope, now, seed, map[string]any{"result": map[string]any{"status": "ready"}})
		gate := claimMemory(t, ctx, store, scope, now, "gate")
		completeMemory(t, ctx, store, scope, now, gate, map[string]any{
			"port": "true", "true": map[string]any{"status": "ready"}, "false": nil,
		})
		yes := claimMemory(t, ctx, store, scope, now, "yes")
		got, _ := yes.Inputs["input"].(map[string]any)
		if got["status"] != "ready" {
			t.Fatalf("yes %#v", yes.Inputs)
		}
		if _, ok := yes.Inputs["false"]; ok {
			t.Fatal("false key flowed")
		}
		for _, v := range yes.Inputs {
			if v == nil {
				t.Fatal("null input")
			}
		}
		steps, err := store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stepByNode(t, steps, "no").Status != ExecutionSkipped {
			t.Fatal("untaken branch was not skipped")
		}
	})

	t.Run("retry uses the succeeded attempt", func(t *testing.T) {
		store := NewMemory()
		exec := startMemory(t, ctx, store, scope, setThenMapYAML)
		seed := claimMemory(t, ctx, store, scope, now, "seed")
		if _, err := store.FailJob(ctx, scope, now, JobActionInput{
			JobID: seed.Job.ID, WorkerID: "mem-worker", FencingToken: seed.Job.FencingToken,
			Error: map[string]any{"code": "boom"},
		}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RetryStep(ctx, scope, now, exec.ID, seed.Step.ID); err != nil {
			t.Fatal(err)
		}
		again := claimMemory(t, ctx, store, scope, now, "seed")
		completeMemory(t, ctx, store, scope, now, again, map[string]any{"result": map[string]any{"status": "second"}})
		mapped := claimMemory(t, ctx, store, scope, now, "mapped")
		got, _ := mapped.Inputs["input"].(map[string]any)
		if got["status"] != "second" {
			t.Fatalf("retry inputs %#v", mapped.Inputs)
		}
	})

	t.Run("approval passes its input", func(t *testing.T) {
		store := NewMemory()
		_ = startMemory(t, ctx, store, scope, approvalThenMapYAML)
		seed := claimMemory(t, ctx, store, scope, now, "seed")
		completeMemory(t, ctx, store, scope, now, seed, map[string]any{"result": map[string]any{"ticket": "CHG-1"}})
		gate := claimMemory(t, ctx, store, scope, now, "gate")
		if _, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: gate.Job.ID, AvailableAt: now.Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ResumeWait(ctx, scope, now, ResumeWaitInput{JobID: gate.Job.ID, Port: "approved"}); err != nil {
			t.Fatal(err)
		}
		after := claimMemory(t, ctx, store, scope, now, "after")
		got, _ := after.Inputs["input"].(map[string]any)
		if got["ticket"] != "CHG-1" {
			t.Fatalf("approval passthrough %#v", after.Inputs)
		}
		if _, ok := after.Inputs["decision"]; ok {
			t.Fatal("decision flowed")
		}
	})

	t.Run("http token is redacted before it is wired", func(t *testing.T) {
		store := NewMemory()
		exec := startMemory(t, ctx, store, scope, httpThenMapYAML)
		call := claimMemory(t, ctx, store, scope, now, "call")
		completeMemory(t, ctx, store, scope, now, call, map[string]any{
			"result": map[string]any{"token": echoMarker, "name": "ok"},
		})
		steps, err := store.ListSteps(ctx, scope, exec.ID)
		if err != nil {
			t.Fatal(err)
		}
		mapped := claimMemory(t, ctx, store, scope, now, "mapped")
		assertRedacted(t, stepByNode(t, steps, "call").Output)
		assertRedacted(t, mapped.Inputs)
		got, _ := mapped.Inputs["input"].(map[string]any)
		if got["name"] != "ok" || got["token"] != redactedMarker {
			t.Fatal("redacted input lost the safe fields")
		}
	})

	t.Run("scalar through a delay reaches map", func(t *testing.T) {
		store := NewMemory()
		_ = startMemory(t, ctx, store, scope, scalarDelayYAML)
		run := claimMemory(t, ctx, store, scope, now, "run")
		completeMemory(t, ctx, store, scope, now, run, map[string]any{"stdout": "demo", "exitCode": 0})
		wait := claimMemory(t, ctx, store, scope, now, "wait")
		if _, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: wait.Job.ID, AvailableAt: now.Add(-time.Minute)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RecoverExpiredLeases(ctx, scope, now); err != nil {
			t.Fatal(err)
		}
		mapped := claimMemory(t, ctx, store, scope, now, "mapped")
		got, _ := mapped.Inputs["input"].(map[string]any)
		if got["value"] != "demo" {
			t.Fatalf("wrapped %#v", mapped.Inputs)
		}
		out := workflow.EvaluateStep(mapped.Step.NodeType, mapped.Step.Input, mapped.Inputs, nil)
		if out.Fail || out.Code == workflow.CodeRequiredInput {
			t.Fatalf("map %+v", out)
		}
		result, _ := out.Output["result"].(map[string]any)
		if result["value"] != "demo" {
			t.Fatalf("map result %#v", out.Output)
		}
	})

	t.Run("unwired delay input is an empty object", func(t *testing.T) {
		store := NewMemory()
		_ = startMemory(t, ctx, store, scope, unwiredDelayYAML)
		wait := claimMemory(t, ctx, store, scope, now, "wait")
		if wait.Inputs != nil {
			t.Fatalf("delay inputs %#v", wait.Inputs)
		}
		if _, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: wait.Job.ID, AvailableAt: now.Add(-time.Minute)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RecoverExpiredLeases(ctx, scope, now); err != nil {
			t.Fatal(err)
		}
		mapped := claimMemory(t, ctx, store, scope, now, "mapped")
		assertEmptyObject(t, mapped.Inputs["input"])
		out := workflow.EvaluateStep(mapped.Step.NodeType, mapped.Step.Input, mapped.Inputs, nil)
		if out.Code == workflow.CodeRequiredInput {
			t.Fatalf("required-input %+v", out)
		}
	})

	t.Run("unwired approval request is an empty object", func(t *testing.T) {
		store := NewMemory()
		_ = startMemory(t, ctx, store, scope, unwiredApprovalYAML)
		gate := claimMemory(t, ctx, store, scope, now, "gate")
		if _, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: gate.Job.ID, AvailableAt: now.Add(time.Hour)}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.ResumeWait(ctx, scope, now, ResumeWaitInput{JobID: gate.Job.ID, Port: "approved"}); err != nil {
			t.Fatal(err)
		}
		mapped := claimMemory(t, ctx, store, scope, now, "mapped")
		assertEmptyObject(t, mapped.Inputs["input"])
		if _, ok := mapped.Inputs["decision"]; ok {
			t.Fatal("decision flowed")
		}
	})

	t.Run("redacted http body passes through a delay", func(t *testing.T) {
		store := NewMemory()
		_ = startMemory(t, ctx, store, scope, echoDelayValidateYAML)
		call := claimMemory(t, ctx, store, scope, now, "call")
		completeMemory(t, ctx, store, scope, now, call, map[string]any{"result": map[string]any{
			"token": redactedMarker, "authorization": redactedMarker,
		}})
		recoverDelay(t, ctx, store, scope, now)
		checked := claimMemory(t, ctx, store, scope, now, "checked")
		got, _ := checked.Inputs["value"].(map[string]any)
		if got["token"] != redactedMarker || got["authorization"] != redactedMarker {
			t.Fatalf("validate input %#v", checked.Inputs)
		}
	})

	t.Run("oversized body through a delay names the delay", func(t *testing.T) {
		store := NewMemory()
		_ = startMemory(t, ctx, store, scope, echoDelayValidateYAML)
		call := claimMemory(t, ctx, store, scope, now, "call")
		completeMemory(t, ctx, store, scope, now, call, map[string]any{"result": map[string]any{
			"body": strings.Repeat("a", 20<<10),
		}})
		recoverDelay(t, ctx, store, scope, now)
		checked := claimMemory(t, ctx, store, scope, now, "checked")
		out := workflow.EvaluateStep(checked.Step.NodeType, checked.Step.Input, checked.Inputs, portsOf(checked.SkippedInputs))
		if out.Code != workflow.CodeOutputTooLarge || !strings.Contains(out.Message, "wait") {
			t.Fatalf("%+v", out)
		}
	})
}

func echoDelaySnaps(body map[string]any) map[string]succeededSnap {
	return map[string]succeededSnap{
		"call": {NodeType: "http.request", Output: map[string]any{"result": body}},
		"wait": {NodeType: "flow.delay", Output: map[string]any{"port": "result", "decision": "result"}},
	}
}

func echoDelayEdges() []execEdge {
	return []execEdge{
		{FromNode: "call", FromPort: "result", ToNode: "wait", ToPort: "input", Satisfied: true, Resolved: true},
		{FromNode: "wait", FromPort: "result", ToNode: "checked", ToPort: "value", Satisfied: true, Resolved: true},
	}
}

func portsOf(in []SkippedInput) []workflow.SkippedPort {
	if len(in) == 0 {
		return nil
	}
	out := make([]workflow.SkippedPort, len(in))
	for i, s := range in {
		out[i] = workflow.SkippedPort{Port: s.Port, From: s.From, Code: s.Code, Message: s.Message}
	}
	return out
}

func recoverDelay(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, now time.Time) {
	t.Helper()
	wait := claimMemory(t, ctx, store, scope, now, "wait")
	if _, err := store.WaitJob(ctx, scope, now, WaitJobInput{JobID: wait.Job.ID, AvailableAt: now.Add(-time.Minute)}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecoverExpiredLeases(ctx, scope, now); err != nil {
		t.Fatal(err)
	}
}

func assertEmptyObject(t *testing.T, v any) {
	t.Helper()
	got, ok := v.(map[string]any)
	if !ok || len(got) != 0 {
		t.Fatalf("want {}, got %#v", v)
	}
}

func assertRedacted(t *testing.T, v any) {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil || bytes.Contains(raw, []byte(echoMarker)) {
		t.Fatal("plaintext marker present in redacted output")
	}
}

func startMemory(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, src string) Execution {
	t.Helper()
	normalized := mustNormalize(t, src)
	wf, draft, err := store.Create(ctx, scope, CreateInput{
		NormalizedYAML: normalized.NormalizedYAML,
		Digest:         normalized.Digest,
		Summary:        normalized.Summary,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, ver, err := store.Publish(ctx, scope, wf.ID, PublishInput{ExpectedRevision: draft.Revision, Note: "inputs"})
	if err != nil {
		t.Fatal(err)
	}
	exec, err := store.StartExecution(ctx, scope, ver.WorkflowID, StartInput{VersionID: ver.ID})
	if err != nil {
		t.Fatal(err)
	}
	return exec
}

func claimMemory(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, now time.Time, node string) DispatchResult {
	t.Helper()
	got, err := store.ClaimJob(ctx, scope, now, ClaimInput{WorkerID: "mem-worker", Lease: time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	if node != "" && got.Step.NodeID != node {
		t.Fatalf("claimed %s, want %s", got.Step.NodeID, node)
	}
	return got
}

func completeMemory(t *testing.T, ctx context.Context, store *Memory, scope isolation.Scope, now time.Time, claimed DispatchResult, output map[string]any) {
	t.Helper()
	if _, err := store.CompleteJob(ctx, scope, now, JobActionInput{
		JobID: claimed.Job.ID, WorkerID: "mem-worker", FencingToken: claimed.Job.FencingToken, Output: output,
	}); err != nil {
		t.Fatal(err)
	}
}

const echoMarker = "vault-echo-token"

const setThenMapYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: set-then-map
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
  edges:
    - from: seed.result
      to: mapped.input
`

const ifElseYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: if-else
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
      to: gate.value
    - from: gate.true
      to: yes.input
    - from: gate.false
      to: no.input
`

const approvalThenMapYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: approval-then-map
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
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
    - id: after
      type: data.map
      name: After
      with:
        mapping:
          ticket: ticket
  edges:
    - from: seed.result
      to: gate.request
    - from: gate.approved
      to: after.input
`

const scalarDelayYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: scalar-delay
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
    - id: wait
      type: flow.delay
      name: Wait
      with:
        duration: PT1S
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          value: value
  edges:
    - from: run.stdout
      to: wait.input
    - from: wait.result
      to: mapped.input
`

const unwiredDelayYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: unwired-delay
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: wait
      type: flow.delay
      name: Wait
      with:
        duration: PT1S
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          value: value
  edges:
    - from: wait.result
      to: mapped.input
`

const unwiredApprovalYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: unwired-approval
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: approver
        expiresIn: PT1H
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          value: value
  edges:
    - from: gate.approved
      to: mapped.input
`

const echoDelayValidateYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: echo-delay-validate
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: call
      type: http.request
      name: Call
      with:
        connectionId: 11111111-1111-4111-8111-111111111111
        method: GET
        path: /
    - id: wait
      type: flow.delay
      name: Wait
      with:
        duration: PT1S
    - id: checked
      type: data.validate
      name: Check
      with:
        schema:
          type: object
  edges:
    - from: call.result
      to: wait.input
    - from: wait.result
      to: checked.value
`

const httpThenMapYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: http-then-map
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: call
      type: http.request
      name: Call
      with:
        connectionId: 11111111-1111-4111-8111-111111111111
        method: GET
        path: /
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          name: name
  edges:
    - from: call.result
      to: mapped.input
`
