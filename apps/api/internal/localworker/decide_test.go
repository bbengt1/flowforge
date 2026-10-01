package localworker

import (
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestDecideCoreDataSetCompletes(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{
		NodeType: "data.set",
		Input:    map[string]any{"value": map[string]any{"status": "ready"}},
	}, wfstore.ExecutionJob{Status: wfstore.JobClaimed, WorkerID: "w"}, nil, nil)
	if d.Fail || d.Skip {
		t.Fatalf("data.set should complete: %+v", d)
	}
	result, _ := d.Output["result"].(map[string]any)
	if result["status"] != "ready" {
		t.Fatalf("output = %#v", d.Output)
	}
}

func TestDecideFlowStopCompletes(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{NodeType: "flow.stop", Input: map[string]any{}}, wfstore.ExecutionJob{Status: wfstore.JobClaimed}, nil, nil)
	if d.Fail || d.Skip {
		t.Fatalf("flow.stop success should complete: %+v", d)
	}
}

func TestDecideFlowFailFails(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{
		NodeType: "flow.fail",
		Input:    map[string]any{"code": "operator-denied", "message": "nope"},
	}, wfstore.ExecutionJob{Status: wfstore.JobClaimed}, nil, nil)
	if !d.Fail || d.Error["code"] != "operator-denied" {
		t.Fatalf("flow.fail = %+v", d)
	}
}

func TestDecideWaitingSkipped(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{NodeType: "flow.approval"}, wfstore.ExecutionJob{Status: wfstore.JobWaiting}, nil, nil)
	if !d.Skip {
		t.Fatalf("waiting should skip: %+v", d)
	}
}

func TestDecideProviderFailsClosed(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{NodeType: "k8s.apply"}, wfstore.ExecutionJob{Status: wfstore.JobClaimed}, nil, nil)
	if !d.Fail || d.Error["code"] != CodeUnsupported {
		t.Fatalf("provider = %+v", d)
	}
}

func TestDecideDelayFailsClosed(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{
		NodeType: "flow.delay",
		Input:    map[string]any{"duration": "PT1S"},
	}, wfstore.ExecutionJob{Status: wfstore.JobClaimed}, nil, nil)
	if !d.Fail || d.Error["code"] != CodeUnsupported {
		t.Fatalf("delay = %+v", d)
	}
}

func TestDecideInputParity(t *testing.T) {
	ready := map[string]any{"status": "ready"}
	job := wfstore.ExecutionJob{Status: wfstore.JobClaimed}
	set := Decide(wfstore.ExecutionStep{
		NodeType: "data.set",
		Input:    map[string]any{"value": ready},
	}, job, nil, nil)
	if set.Fail {
		t.Fatalf("data.set %+v", set)
	}
	if got, _ := set.Output["result"].(map[string]any); got["status"] != "ready" {
		t.Fatalf("data.set output %#v", set.Output)
	}

	mapped := Decide(wfstore.ExecutionStep{
		NodeType: "data.map",
		Input:    map[string]any{"mapping": map[string]any{"status": "status"}},
	}, job, map[string]any{"input": ready}, nil)
	if mapped.Fail {
		t.Fatalf("data.map %+v", mapped)
	}
	if got, _ := mapped.Output["result"].(map[string]any); got["status"] != "ready" {
		t.Fatalf("data.map output %#v", mapped.Output)
	}

	missing := Decide(wfstore.ExecutionStep{
		NodeType: "data.map",
		Input:    map[string]any{"mapping": map[string]any{"status": "status"}},
	}, job, nil, nil)
	if !missing.Fail || missing.Error["code"] != "required-input" {
		t.Fatalf("missing input %+v", missing)
	}

	skipped := Decide(wfstore.ExecutionStep{
		NodeType: "data.map",
		Input:    map[string]any{"mapping": map[string]any{"status": "status"}},
	}, job, nil, []wfstore.SkippedInput{{Port: "input", From: "left.result"}})
	if !skipped.Fail || skipped.Error["code"] != "upstream-skipped" {
		t.Fatalf("skipped %+v", skipped)
	}

	optionalSkip := Decide(wfstore.ExecutionStep{
		NodeType: "data.map",
		Input:    map[string]any{"mapping": map[string]any{"status": "status"}},
	}, job, nil, []wfstore.SkippedInput{{Port: "note", From: "side.result"}})
	if !optionalSkip.Fail || optionalSkip.Error["code"] != "required-input" {
		t.Fatalf("optional skip %+v", optionalSkip)
	}

	validate := Decide(wfstore.ExecutionStep{
		NodeType: "data.validate",
		Input:    map[string]any{"schema": map[string]any{"type": "object"}},
	}, job, nil, nil)
	if !validate.Fail || validate.Error["code"] != "required-input" {
		t.Fatalf("validate %+v", validate)
	}

	cond := Decide(wfstore.ExecutionStep{
		NodeType: "flow.condition",
		Input:    map[string]any{"op": "eq", "path": "status", "compare": "ready"},
	}, job, map[string]any{"value": ready}, nil)
	if cond.Fail {
		t.Fatalf("condition %+v", cond)
	}
	if _, ok := cond.Output["false"]; !ok || cond.Output["false"] != nil {
		t.Fatalf("condition false port %#v", cond.Output)
	}
	if got, _ := cond.Output["true"].(map[string]any); got["status"] != "ready" {
		t.Fatalf("condition true %#v", cond.Output["true"])
	}

	denied := Decide(wfstore.ExecutionStep{
		NodeType: "flow.fail",
		Input:    map[string]any{"code": "operator-denied", "message": "nope"},
	}, job, nil, nil)
	if !denied.Fail || denied.Error["code"] != "operator-denied" {
		t.Fatalf("flow.fail %+v", denied)
	}
}
