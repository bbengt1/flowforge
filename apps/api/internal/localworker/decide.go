package localworker

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Decision is the local worker's action for one claimed job.
type Decision struct {
	Skip    bool
	Reason  string
	Fail    bool
	Output  map[string]any
	Error   map[string]any
	Message string
	// ItemRouting is set when per-item onError routed some items (E3.5).
	ItemRouting *wfstore.ItemRouting
}

// Decide evaluates a claimed step without calling a provider. Approval
// waits are parked by the API on claim (no lease). Provider nodes and
// durable delay fail closed so the run leaves queued with a reason.
// inputs and skipped come from the claim response.
func Decide(step wfstore.ExecutionStep, job wfstore.ExecutionJob, inputs map[string]any, skipped []wfstore.SkippedInput) Decision {
	return DecideRun(context.Background(), wfstore.Execution{}, step, job, inputs, skipped)
}

// DecideRun is Decide with the claimed execution, so FFX expressions get
// run.clock (the attempt's eval_clock) and the run and workflow fields.
func DecideRun(ctx context.Context, exec wfstore.Execution, step wfstore.ExecutionStep, job wfstore.ExecutionJob, inputs map[string]any, skipped []wfstore.SkippedInput) Decision {
	if job.Status == wfstore.JobWaiting || step.NodeType == "flow.approval" {
		return Decision{Skip: true, Reason: "waiting"}
	}
	if workflow.IsTestNode(step.NodeType) {
		// Only reachable in -tags fftest builds (#651 fixturesuite).
		return decisionFromOutcome(workflow.EvaluateTestStep(step.NodeType, step.Input, step.Attempt))
	}
	if !workflow.IsCoreNeutral(step.NodeType) {
		return unsupported("Compose local worker cannot execute provider nodes. Deploy an isolated production worker.")
	}
	if step.NodeType == "flow.delay" {
		return unsupported("Compose local worker does not schedule durable flow.delay waits.")
	}
	return decisionFromOutcome(workflow.EvaluateStepRun(step.NodeType, step.Input, inputs, skippedPorts(skipped), wfstore.RunContextFor(ctx, exec, step), step.OnError))
}

func skippedPorts(in []wfstore.SkippedInput) []workflow.SkippedPort {
	if len(in) == 0 {
		return nil
	}
	out := make([]workflow.SkippedPort, len(in))
	for i, s := range in {
		out[i] = workflow.SkippedPort{Port: s.Port, From: s.From, Code: s.Code, Message: s.Message}
	}
	return out
}

func decisionFromOutcome(o workflow.StepOutcome) Decision {
	if !o.Fail {
		d := Decision{Output: o.Output}
		if o.Routed {
			d.ItemRouting = &wfstore.ItemRouting{Mode: o.RouteMode, Count: o.RoutedCount}
		}
		return d
	}
	return Decision{
		Fail:    true,
		Output:  o.Output,
		Error:   map[string]any{"code": o.Code, "message": o.Message},
		Message: o.Message,
	}
}

func unsupported(message string) Decision {
	return Decision{
		Fail:    true,
		Error:   map[string]any{"code": CodeUnsupported, "message": message},
		Message: message,
	}
}
