//go:build fftest

package workflow

import "fmt"

// test.flaky exists ONLY in builds with -tags fftest (#651 fixture 07).
//
//	with: {failTimes: N}     fail attempts 1..N, succeed from attempt N+1 (0 <= N <= 10)
//	with: {mode: alwaysFail} fail every attempt
//
// Exactly one of failTimes or mode is required. The outcome is a pure
// function of with + attempt number. It is retrySafe so retry policy applies.
func init() {
	registerTestNode(testNode{
		contract: NodeType{
			Type:        "test.flaky",
			Phase:       PhaseCore,
			Title:       "Test flaky (fftest only)",
			Description: "Deterministic failure fixture. Built only with -tags fftest.",
			Inputs:      []Port{inheritPort("input", PortAny, false, "Ignored input.")},
			Outputs:     []Port{publicObjectPort("result", "{attempt} on success.")},
			AllowedWith: []WithField{
				{Name: "failTimes", Kind: "integer", Description: "Fail the first N attempts (0-10), then succeed."},
				{Name: "mode", Kind: "string", Enum: []string{"alwaysFail"}, Description: "alwaysFail fails every attempt."},
			},
			Policy: defaultNeutralPolicy(),
			Bounds: defaultNeutralBounds(),
		},
		validate: validateFlaky,
		eval:     evalFlaky,
	})
}

const CodeTestFlakyFailure = "test-flaky-failure"

func validateFlaky(n Node, path string) ErrorList {
	var errs ErrorList
	for k := range n.With {
		if k != "failTimes" && k != "mode" {
			errs = append(errs, fieldError(path+".with."+k, n.pos.Line, n.pos.Column, CodeUnknownField, fmt.Sprintf("test.flaky does not allow with.%s.", k)))
		}
	}
	ft, hasFT := n.With["failTimes"]
	mode, hasMode := n.With["mode"]
	switch {
	case hasFT && hasMode:
		errs = append(errs, fieldError(path+".with", n.pos.Line, n.pos.Column, CodeInvalidWith, "test.flaky takes failTimes or mode, not both."))
	case !hasFT && !hasMode:
		errs = append(errs, fieldError(path+".with", n.pos.Line, n.pos.Column, CodeMissingField, "test.flaky requires with.failTimes or with.mode."))
	case hasFT && !isBoundedInt(ft, 0, 10):
		errs = append(errs, fieldError(path+".with.failTimes", n.pos.Line, n.pos.Column, CodeInvalidWith, "failTimes must be an integer between 0 and 10."))
	case hasMode && mode != "alwaysFail":
		errs = append(errs, fieldError(path+".with.mode", n.pos.Line, n.pos.Column, CodeInvalidWith, `mode must be "alwaysFail".`))
	}
	return errs
}

func evalFlaky(with map[string]any, attempt int) StepOutcome {
	if attempt < 1 {
		attempt = 1
	}
	if with["mode"] == "alwaysFail" {
		return StepOutcome{Fail: true, Code: CodeTestFlakyFailure, Message: fmt.Sprintf("test.flaky alwaysFail: attempt %d failed.", attempt)}
	}
	n, ok := flakyInt(with["failTimes"])
	if !ok {
		return StepOutcome{Fail: true, Code: CodeInvalidWith, Message: "test.flaky has no valid failTimes."}
	}
	if attempt <= n {
		return StepOutcome{Fail: true, Code: CodeTestFlakyFailure, Message: fmt.Sprintf("test.flaky: attempt %d of %d planned failures.", attempt, n)}
	}
	return StepOutcome{Output: map[string]any{"result": map[string]any{"attempt": attempt}}}
}

// flakyInt accepts YAML ints and JSON numbers (step input round-trips JSON).
func flakyInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, n >= 0 && n <= 10
	case int64:
		return int(n), n >= 0 && n <= 10
	case uint64:
		return int(n), n <= 10
	case float64:
		return int(n), n == float64(int(n)) && n >= 0 && n <= 10
	default:
		return 0, false
	}
}
