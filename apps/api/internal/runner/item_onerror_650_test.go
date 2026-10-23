package runner

import (
	"context"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// H1: StoreQueue.Complete must forward ItemRouting so the in-process
// production runner marks succeededWithErrors, writes step.error_routed,
// and opens the error port (parity with the HTTP local-worker path).
func TestStoreQueueCompleteItemRoutingSWE650(t *testing.T) {
	r, _ := newRig(t, authz.ExpandRoles([]string{authz.RoleOperator}))
	exec := r.start(t, r.publish(t, itemOnErrorSortRunnerYAML))
	if _, err := r.loop.Drain(context.Background()); err != nil {
		t.Fatal(err)
	}
	steps, err := r.wf.ListSteps(context.Background(), r.scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	var sortStep, errStep wfstore.ExecutionStep
	for _, s := range steps {
		switch s.NodeID {
		case "sort":
			sortStep = s
		case "err":
			errStep = s
		}
	}
	if sortStep.ID == "" {
		t.Fatal("missing sort step")
	}
	if sortStep.Status != wfstore.ExecutionSucceededWithErrors {
		t.Fatalf("sort status=%s err=%v output=%#v", sortStep.Status, sortStep.Error, sortStep.Output)
	}
	if sortStep.ErrorHandling != wfstore.ErrorHandlingOutput {
		t.Fatalf("sort errorHandling=%q", sortStep.ErrorHandling)
	}
	if errStep.ID == "" || errStep.Status != wfstore.ExecutionSucceeded {
		t.Fatalf("error-port downstream status=%s (want succeeded; port must release)", errStep.Status)
	}
	audits, err := r.wf.ListAuditEvents(context.Background(), r.scope, wfstore.AuditListFilter{
		Action: wfstore.ActionStepErrorRouted, ResourceID: exec.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(audits) != 1 {
		t.Fatalf("step.error_routed audits=%d", len(audits))
	}
	switch got := audits[0].Details["count"].(type) {
	case int:
		if got != 1 {
			t.Fatalf("audit count=%d", got)
		}
	case int64:
		if got != 1 {
			t.Fatalf("audit count=%d", got)
		}
	case float64:
		if got != 1 {
			t.Fatalf("audit count=%v", got)
		}
	default:
		t.Fatalf("audit count=%#v details=%#v", got, audits[0].Details)
	}
	run, err := r.wf.GetExecutionByID(context.Background(), r.scope, exec.ID)
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != wfstore.ExecutionSucceededWithErrors {
		t.Fatalf("run status=%s", run.Status)
	}
}

const itemOnErrorSortRunnerYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: runner-item-onerror-sort
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
            - {x: 1}
    - id: sort
      type: data.sort
      name: Sort
      onError: errorOutput
      with:
        key: k
        type: string
    - id: ok
      type: flow.stop
      name: Ok
      with:
        status: success
    - id: err
      type: flow.stop
      name: Err
      with:
        status: success
  edges:
    - from: seed.result
      to: sort.input
    - from: sort.result
      to: ok.input
    - from: sort.error
      to: err.input
`
