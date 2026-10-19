package wfstore

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// RunContextFor is the FFX runtime context for one claimed attempt (#650
// E3.3). run.clock is the attempt's eval_clock, never the wall clock; a
// claim without one leaves Clock nil so run.clock fails closed.
func RunContextFor(ctx context.Context, exec Execution, step ExecutionStep) *workflow.RunContext {
	rc := &workflow.RunContext{
		Ctx:        ctx,
		NodeID:     step.NodeID,
		RunID:      firstNonEmptyID(exec.ID, step.ExecutionID),
		WorkflowID: exec.WorkflowID,
		VersionID:  exec.WorkflowVersionID,
	}
	if exec.StartedAt != nil {
		rc.StartedAt = exec.StartedAt.UTC()
	}
	if step.EvalClock != nil {
		clk := step.EvalClock.UTC()
		rc.Clock = &clk
	}
	return rc
}

func firstNonEmptyID(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
