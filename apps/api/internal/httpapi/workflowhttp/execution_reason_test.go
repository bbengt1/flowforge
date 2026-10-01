package workflowhttp

import (
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestExecutionStatusReasonUnresolvable(t *testing.T) {
	now := time.Date(2026, 9, 26, 2, 0, 0, 0, time.UTC)
	exec := wfstore.Execution{Status: wfstore.ExecutionFailed}
	steps := []wfstore.ExecutionStep{{
		Error: map[string]any{"code": wfstore.ReasonRequirementUnresolvable},
	}}
	if got := ExecutionStatusReason(exec, steps, nil, now); got != wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("reason = %q", got)
	}
	mixed := []wfstore.ExecutionStep{
		{Error: map[string]any{"code": wfstore.ReasonWorkflowDeleted}},
		{Error: map[string]any{"code": wfstore.ReasonRequirementUnresolvable}},
	}
	if got := ExecutionStatusReason(exec, mixed, nil, now); got != wfstore.ReasonRequirementUnresolvable {
		t.Fatalf("mixed reason = %q", got)
	}
	deleted := []wfstore.ExecutionStep{{
		Error: map[string]any{"code": wfstore.ReasonWorkflowDeleted},
	}}
	if got := ExecutionStatusReason(exec, deleted, nil, now); got != wfstore.ReasonWorkflowDeleted {
		t.Fatalf("deleted reason = %q", got)
	}
}
