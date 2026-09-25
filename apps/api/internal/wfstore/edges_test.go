package wfstore

import (
	"testing"
	"time"
)

func TestReleaseSkipsWhenRequiredGateIsUnsatisfied(t *testing.T) {
	now := time.Now().UTC()
	steps := []ExecutionStep{
		{ID: "side", NodeID: "side", Attempt: 1, Status: ExecutionSucceeded},
		{ID: "join", NodeID: "join", Attempt: 1, Status: ExecutionPending, UnresolvedIncoming: 2},
		{ID: "tail", NodeID: "tail", Attempt: 1, Status: ExecutionPending, UnresolvedIncoming: 1},
	}
	jobs := []ExecutionJob{
		{ID: "j-join", ExecutionStepID: "join", Status: JobBlocked},
		{ID: "j-tail", ExecutionStepID: "tail", Status: JobBlocked},
	}
	edges := []execEdge{
		{FromNode: "gate", FromPort: "approved", ToNode: "join", ToPort: "parameters", Required: true},
		{FromNode: "side", FromPort: "true", ToNode: "join", ToPort: "manifests"},
		{FromNode: "join", FromPort: "result", ToNode: "tail", ToPort: "input"},
	}
	// The non-gate input already succeeded.
	edges[1].Resolved = true
	edges[1].Satisfied = true
	steps[1].UnresolvedIncoming = 1

	releaseFrom(steps, jobs, edges, "gate", map[string]struct{}{"rejected": {}}, now)
	if steps[1].Status != ExecutionSkipped || jobs[0].Status != JobSkipped {
		t.Fatalf("join step=%s job=%s", steps[1].Status, jobs[0].Status)
	}
	if steps[2].Status != ExecutionSkipped || jobs[1].Status != JobSkipped {
		t.Fatalf("tail step=%s job=%s", steps[2].Status, jobs[1].Status)
	}
}

func TestReleaseQueuesOnce(t *testing.T) {
	now := time.Now().UTC()
	steps := []ExecutionStep{
		{ID: "next", NodeID: "next", Attempt: 1, Status: ExecutionPending, UnresolvedIncoming: 1},
	}
	jobs := []ExecutionJob{
		{ID: "j-next", ExecutionStepID: "next", Status: JobBlocked},
	}
	edges := []execEdge{
		{FromNode: "seed", FromPort: "result", ToNode: "next", ToPort: "input"},
	}
	ports := map[string]struct{}{"result": {}}
	releaseFrom(steps, jobs, edges, "seed", ports, now)
	releaseFrom(steps, jobs, edges, "seed", ports, now)
	if steps[0].Status != ExecutionQueued || jobs[0].Status != JobQueued {
		t.Fatalf("step=%s job=%s", steps[0].Status, jobs[0].Status)
	}
	if !edges[0].Resolved || !edges[0].Satisfied {
		t.Fatalf("edge=%+v", edges[0])
	}
}
