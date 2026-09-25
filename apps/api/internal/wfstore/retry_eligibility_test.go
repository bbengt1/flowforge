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
	err := classifyRetry(exec, step, []ExecutionStep{step}, nil, false)
	var refused *NotRetryableError
	if !errors.As(err, &refused) || refused.Reason != ReasonRunCanceled {
		t.Fatalf("canceled = %v", err)
	}
	exec.Status = ExecutionFailed
	step.StartedAt = nil
	step.Status = ExecutionPending
	err = classifyRetry(exec, step, []ExecutionStep{step}, nil, false)
	if !errors.As(err, &refused) || refused.Reason != ReasonStepNotStarted {
		t.Fatalf("unstarted = %v", err)
	}
	older := step
	older.Status = ExecutionFailed
	older.StartedAt = &started
	newer := older
	newer.ID = "newer"
	newer.Attempt = 2
	err = classifyRetry(exec, older, []ExecutionStep{older, newer}, nil, false)
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

func TestRetryCapabilityMatchesEveryRefusal(t *testing.T) {
	cases := []struct {
		err    error
		code   string
		reason string
	}{
		{&NotRetryableError{Reason: ReasonRunCanceled}, CodeExecutionNotRetryable, ReasonRunCanceled},
		{&NotRetryableError{Reason: ReasonRunNotFailed}, CodeExecutionNotRetryable, ReasonRunNotFailed},
		{&NotRetryableError{Reason: ReasonStepNotStarted}, CodeExecutionNotRetryable, ReasonStepNotStarted},
		{&NotRetryableError{Reason: ReasonStepNotFailed}, CodeExecutionNotRetryable, ReasonStepNotFailed},
		{&NotRetryableError{Reason: ReasonIncomingUnresolved}, CodeExecutionNotRetryable, ReasonIncomingUnresolved},
		{&NotRetryableError{Reason: ReasonRetryNotAllowed}, CodeExecutionNotRetryable, ReasonRetryNotAllowed},
		{&NotRetryableError{Reason: ReasonWorkflowDeleted}, CodeExecutionNotRetryable, ReasonWorkflowDeleted},
		{ErrRetryNotAllowed, CodeExecutionNotRetryable, ReasonRetryNotAllowed},
		{ErrRetryDenied, CodeExecutionNotRetryable, ReasonRetryNotAllowed},
		{ErrStepAttemptSuperseded, CodeStepAttemptSuperseded, ""},
	}
	for _, tc := range cases {
		cap := retryCapability(tc.err)
		if cap.Allowed || cap.Code != tc.code || cap.Reason != tc.reason {
			t.Fatalf("%v capability = %+v", tc.err, cap)
		}
	}
	now := time.Now().UTC()
	started := now
	step := ExecutionStep{ID: "s", NodeID: "seed", NodeType: "data.set", Attempt: 1, Status: ExecutionFailed, StartedAt: &started}
	err := classifyRetry(Execution{Status: ExecutionFailed}, step, []ExecutionStep{step}, []execEdge{{ToNode: "seed", Required: true}}, true)
	cap := retryCapability(err)
	if cap.Allowed || cap.Code != CodeExecutionNotRetryable || cap.Reason != ReasonWorkflowDeleted {
		t.Fatalf("tombstone = %+v (%v)", cap, err)
	}
	err = classifyRetry(Execution{Status: ExecutionFailed}, step, []ExecutionStep{step}, []execEdge{{ToNode: "seed", Required: true, Resolved: false}}, false)
	cap = retryCapability(err)
	if cap.Code != CodeExecutionNotRetryable || cap.Reason != ReasonIncomingUnresolved {
		t.Fatalf("incoming = %+v (%v)", cap, err)
	}
}
