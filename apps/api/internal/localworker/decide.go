package localworker

import (
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
}

// Decide evaluates a claimed step without calling a provider. Approval
// waits are parked by the API on claim (no lease). Provider nodes and
// durable delay fail closed so the run leaves queued with a reason.
// inputs and skipped come from the claim response.
func Decide(step wfstore.ExecutionStep, job wfstore.ExecutionJob, inputs map[string]any, skipped []wfstore.SkippedInput) Decision {
	if job.Status == wfstore.JobWaiting || step.NodeType == "flow.approval" {
		return Decision{Skip: true, Reason: "waiting"}
	}
	if !workflow.IsCoreNeutral(step.NodeType) {
		return unsupported("Compose local worker cannot execute provider nodes. Deploy an isolated production worker.")
	}
	if step.NodeType == "flow.delay" {
		return unsupported("Compose local worker does not schedule durable flow.delay waits.")
	}
	return decisionFromOutcome(workflow.EvaluateStep(step.NodeType, step.Input, inputs, skippedPorts(skipped)))
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
		return Decision{Output: o.Output}
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
