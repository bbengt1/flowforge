package workflow

import (
	"context"

	"fmt"
	"github.com/bbengt1/flowforge/apps/api/internal/expr"
	"strings"
)

// SkippedPort is a required-or-optional input whose incoming edge did not fire,
// or a wired port the resolver could not forward. Code, when set, is the
// failure the next step must report instead of required-input.
type SkippedPort struct {
	Port    string
	From    string
	Code    string
	Message string
}

// StepOutcome is the shared core evaluation result for both workers.
type StepOutcome struct {
	Fail    bool
	Output  map[string]any
	Code    string
	Message string
}

// EvaluateStep applies wired inputs to a core node. A skipped port that the
// catalog marks required fails with upstream-skipped before evaluation, so a
// join: any step is not reported as a merely missing required-input. The
// per-port size cap stays inside Evaluate.
func EvaluateStep(nodeType string, with, inputs map[string]any, skipped []SkippedPort) StepOutcome {
	return EvaluateStepRun(nodeType, with, inputs, skipped, nil)
}

// EvaluateStepRun is EvaluateStep with the attempt's RunContext, which FFX
// expr fields need (#650 E3.3). Workers call this.
func EvaluateStepRun(nodeType string, with, inputs map[string]any, skipped []SkippedPort, rc *RunContext) StepOutcome {
	// A join: any step fails on any skipped entry that has a code, even when
	// another branch delivered a value. That is deliberate: fail closed.
	for _, s := range skipped {
		if s.Code == "" {
			continue
		}
		msg := s.Message
		if msg == "" {
			msg = s.From
		}
		return StepOutcome{Fail: true, Code: s.Code, Message: msg}
	}
	if nt, ok := lookupNode(nodeType); ok {
		required := map[string]bool{}
		for _, p := range nt.Inputs {
			if p.Required {
				required[p.Name] = true
			}
		}
		for _, s := range skipped {
			if required[s.Port] {
				return StepOutcome{
					Fail:    true,
					Code:    CodeUpstreamSkipped,
					Message: fmt.Sprintf("Required input %s was not produced by %s.", s.Port, s.From),
				}
			}
		}
	}
	var deadline context.CancelFunc
	if rc != nil {
		base := rc.Ctx
		if base == nil {
			base = context.Background()
		}
		// 2 s per step on top of the 10 ms per evaluation (#650 §4).
		rcCopy := *rc
		rcCopy.Ctx, deadline = context.WithTimeout(base, expr.StepDeadline)
		defer deadline()
		rc = &rcCopy
	}
	res, errs := EvaluateRun(nodeType, with, inputs, rc)
	if len(errs) > 0 {
		code := errs[0].Code
		if code == "" {
			code = "eval-failed"
		}
		return StepOutcome{Fail: true, Code: code, Message: errs[0].Message}
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
			return StepOutcome{Fail: true, Output: out, Code: code, Message: res.Terminal.Message}
		}
	}
	return StepOutcome{Output: out}
}
