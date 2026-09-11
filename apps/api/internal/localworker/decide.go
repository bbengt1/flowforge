package localworker

import (
	"strings"

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
func Decide(step wfstore.ExecutionStep, job wfstore.ExecutionJob) Decision {
	if job.Status == wfstore.JobWaiting || step.NodeType == "flow.approval" {
		return Decision{Skip: true, Reason: "waiting"}
	}
	if !workflow.IsCoreNeutral(step.NodeType) {
		return unsupported("Compose local worker cannot execute provider nodes. Deploy an isolated production worker.")
	}
	if step.NodeType == "flow.delay" {
		return unsupported("Compose local worker does not schedule durable flow.delay waits.")
	}

	res, errs := workflow.Evaluate(step.NodeType, step.Input, map[string]any{})
	if len(errs) > 0 {
		code := errs[0].Code
		if code == "" {
			code = "eval-failed"
		}
		return Decision{
			Fail:    true,
			Error:   map[string]any{"code": code, "message": errs[0].Message},
			Message: errs[0].Message,
		}
	}
	out := map[string]any{}
	if res != nil && res.Outputs != nil {
		out = res.Outputs
	}
	if res != nil && res.Terminal != nil {
		switch res.Terminal.Status {
		case "failure", "canceled":
			code := strings.TrimSpace(res.Terminal.Code)
			if code == "" {
				code = res.Terminal.Status
			}
			return Decision{
				Fail:    true,
				Output:  out,
				Error:   map[string]any{"code": code, "message": res.Terminal.Message},
				Message: res.Terminal.Message,
			}
		}
	}
	return Decision{Output: out}
}

func unsupported(message string) Decision {
	return Decision{
		Fail:    true,
		Error:   map[string]any{"code": CodeUnsupported, "message": message},
		Message: message,
	}
}
