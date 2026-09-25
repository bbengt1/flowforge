package wfstore

import (
	"errors"
	"testing"
	"time"
)

func TestEmittedPortsUsesDeclaredPortsWhenValueIsNull(t *testing.T) {
	ports := emittedPorts("data.set", map[string]any{"result": nil})
	if _, ok := ports["result"]; !ok {
		t.Fatalf("ports = %#v", ports)
	}
	routed := emittedPorts("flow.condition", map[string]any{"port": "false", "true": nil, "false": nil})
	if _, ok := routed["false"]; !ok || len(routed) != 1 {
		t.Fatalf("routed = %#v", routed)
	}
	if got := emittedPorts("not.a.node", map[string]any{"result": "x"}); len(got) != 0 {
		t.Fatalf("unknown = %#v", got)
	}
}

func TestClassifyRetryRefusesCanceledAndUnstarted(t *testing.T) {
	now := time.Now().UTC()
	started := now
	exec := Execution{Status: ExecutionCanceled}
	step := ExecutionStep{ID: "s", NodeID: "after", NodeType: "flow.stop", Attempt: 1, Status: ExecutionCanceled, StartedAt: &started}
	err := classifyRetry(exec, step, []ExecutionStep{step}, nil)
	var refused *NotRetryableError
	if !errors.As(err, &refused) || refused.Reason != ReasonRunCanceled {
		t.Fatalf("canceled = %v", err)
	}
	exec.Status = ExecutionFailed
	step.StartedAt = nil
	step.Status = ExecutionPending
	err = classifyRetry(exec, step, []ExecutionStep{step}, nil)
	if !errors.As(err, &refused) || refused.Reason != ReasonStepNotStarted {
		t.Fatalf("unstarted = %v", err)
	}
	older := step
	older.Status = ExecutionFailed
	older.StartedAt = &started
	newer := older
	newer.ID = "newer"
	newer.Attempt = 2
	err = classifyRetry(exec, older, []ExecutionStep{older, newer}, nil)
	if !errors.Is(err, ErrStepAttemptSuperseded) {
		t.Fatalf("superseded = %v", err)
	}
}

func TestRollupIgnoresSupersededFailure(t *testing.T) {
	steps := []ExecutionStep{
		{ID: "old", NodeID: "seed", Attempt: 1},
		{ID: "new", NodeID: "seed", Attempt: 2},
		{ID: "next", NodeID: "next", Attempt: 1},
	}
	jobs := []ExecutionJob{
		{ExecutionStepID: "old", Status: JobFailed},
		{ExecutionStepID: "new", Status: JobSucceeded},
		{ExecutionStepID: "next", Status: JobSucceeded},
	}
	if got := rollupExecutionStatus(jobs, steps); got != ExecutionSucceeded {
		t.Fatalf("status = %s", got)
	}
	if got := guardCanceledRollup(ExecutionCanceled, ExecutionSucceeded); got != ExecutionCanceled {
		t.Fatalf("canceled rollup = %s", got)
	}
}

func TestIncomingReadyRequiresSatisfiedJoin(t *testing.T) {
	edges := []execEdge{{ToNode: "after", Required: true, Resolved: true, Satisfied: false}}
	ready, n := incomingReady("after", edges)
	if ready || n != 0 {
		t.Fatalf("unsatisfied ready=%v n=%d", ready, n)
	}
	edges[0].Satisfied = true
	ready, n = incomingReady("after", edges)
	if !ready || n != 0 {
		t.Fatalf("satisfied ready=%v n=%d", ready, n)
	}
	ready, n = incomingReady("seed", nil)
	if !ready || n != 0 {
		t.Fatalf("root ready=%v n=%d", ready, n)
	}
}
