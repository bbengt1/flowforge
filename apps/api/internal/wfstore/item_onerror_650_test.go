package wfstore

import (
	"context"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestMemoryItemRoutingSucceededWithErrors650(t *testing.T) {
	scope, err := isolation.Authorize("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	store := NewMemory()
	h := routeHarness{t: t, ctx: context.Background(), store: store, scope: scope}
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: item-route
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
          items:
            - {k: a}
    - id: sort
      type: data.sort
      name: Sort
      onError: continue
      with:
        key: k
        type: string
    - id: done
      type: flow.stop
      name: Done
      with:
        status: success
  edges:
    - from: seed.result
      to: sort.input
    - from: sort.result
      to: done.input
`
	exec, _ := h.start(src)
	h.complete(h.claim("seed"), map[string]any{"result": map[string]any{"items": []any{map[string]any{"k": "a"}}}})
	claim := h.claim("sort")
	if claim.Step.OnError != workflow.OnErrorContinue {
		t.Fatalf("claim OnError = %q", claim.Step.OnError)
	}
	res, err := store.CompleteJob(h.ctx, h.scope, h.now(), JobActionInput{
		JobID: claim.Job.ID, WorkerID: "route-worker", FencingToken: claim.Job.FencingToken,
		Output:      map[string]any{"result": workflow.ContinueAllFailedItems()},
		ItemRouting: &ItemRouting{Mode: ErrorHandlingContinue, Count: 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Step.Status != ExecutionSucceededWithErrors {
		t.Fatalf("step status = %s", res.Step.Status)
	}
	if res.Step.ErrorHandling != ErrorHandlingContinue {
		t.Fatalf("errorHandling = %q", res.Step.ErrorHandling)
	}
	h.complete(h.claim("done"), map[string]any{"result": map[string]any{}})
	if got := h.run(exec.ID); got.Status != ExecutionSucceededWithErrors {
		t.Fatalf("run status = %s", got.Status)
	}
	if n := h.audits(exec.ID, ActionStepErrorRouted); n != 1 {
		t.Fatalf("step.error_routed = %d", n)
	}
}

func TestMemoryLeaseLossMarksUnknownItemsIndeterminate650(t *testing.T) {
	exec := memExecution{items: map[string]map[string][]StepItem{}}
	sid := newID()
	exec.items[sid] = map[string][]StepItem{
		"result": {
			{Idx: 0, Item: map[string]any{"ok": true}, Lineage: map[string]any{"idx": 0, "src": []any{}}, Status: ItemStatusSucceeded},
			{Idx: 1, Item: map[string]any{}, Lineage: map[string]any{"idx": 1, "src": []any{}}, Status: ItemStatusUnknown},
		},
	}
	markMemoryItemsIndeterminate(&exec, sid)
	list := exec.items[sid]["result"]
	if list[0].Status != ItemStatusSucceeded {
		t.Fatalf("succeeded became %s", list[0].Status)
	}
	if list[1].Status != ItemStatusIndeterminate {
		t.Fatalf("unknown became %s", list[1].Status)
	}
}

func TestItemErrorRoutedAuditHasCountNotContents650(t *testing.T) {
	a := itemErrorRoutedAudit("e", ExecutionStep{NodeID: "sort", Attempt: 1, NodeType: "data.sort"}, ItemRouting{Mode: ErrorHandlingOutput, Count: 3})
	if a.Action != ActionStepErrorRouted {
		t.Fatalf("action = %s", a.Action)
	}
	if a.Details["count"] != 3 {
		t.Fatalf("details = %#v", a.Details)
	}
	for _, k := range []string{"items", "item", "value", "expr"} {
		if _, ok := a.Details[k]; ok {
			t.Fatalf("audit must not carry %s", k)
		}
	}
}
