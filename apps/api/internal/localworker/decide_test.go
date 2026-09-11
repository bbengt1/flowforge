package localworker

import (
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestDecideCoreDataSetCompletes(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{
		NodeType: "data.set",
		Input:    map[string]any{"value": map[string]any{"status": "ready"}},
	}, wfstore.ExecutionJob{Status: wfstore.JobClaimed, WorkerID: "w"})
	if d.Fail || d.Skip {
		t.Fatalf("data.set should complete: %+v", d)
	}
	result, _ := d.Output["result"].(map[string]any)
	if result["status"] != "ready" {
		t.Fatalf("output = %#v", d.Output)
	}
}

func TestDecideFlowStopCompletes(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{NodeType: "flow.stop", Input: map[string]any{}}, wfstore.ExecutionJob{Status: wfstore.JobClaimed})
	if d.Fail || d.Skip {
		t.Fatalf("flow.stop success should complete: %+v", d)
	}
}

func TestDecideFlowFailFails(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{
		NodeType: "flow.fail",
		Input:    map[string]any{"code": "operator-denied", "message": "nope"},
	}, wfstore.ExecutionJob{Status: wfstore.JobClaimed})
	if !d.Fail || d.Error["code"] != "operator-denied" {
		t.Fatalf("flow.fail = %+v", d)
	}
}

func TestDecideWaitingSkipped(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{NodeType: "flow.approval"}, wfstore.ExecutionJob{Status: wfstore.JobWaiting})
	if !d.Skip {
		t.Fatalf("waiting should skip: %+v", d)
	}
}

func TestDecideProviderFailsClosed(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{NodeType: "k8s.apply"}, wfstore.ExecutionJob{Status: wfstore.JobClaimed})
	if !d.Fail || d.Error["code"] != CodeUnsupported {
		t.Fatalf("provider = %+v", d)
	}
}

func TestDecideDelayFailsClosed(t *testing.T) {
	d := Decide(wfstore.ExecutionStep{
		NodeType: "flow.delay",
		Input:    map[string]any{"duration": "PT1S"},
	}, wfstore.ExecutionJob{Status: wfstore.JobClaimed})
	if !d.Fail || d.Error["code"] != CodeUnsupported {
		t.Fatalf("delay = %+v", d)
	}
}
