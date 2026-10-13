package fixturesuite

import "fmt"

// Outcome is a fixture driver's strict-xfail verdict.
type Outcome string

const (
	OutcomePass  Outcome = "PASS"
	OutcomeFail  Outcome = "FAIL"
	OutcomeXFail Outcome = "XFAIL"
	OutcomeXPass Outcome = "XPASS"
	// OutcomePending is a part whose result rests on expectation keys the
	// harness does not evaluate yet. It always fails CI: a harness gap is
	// never a product failure and never satisfies an xfail tag.
	OutcomePending Outcome = "HARNESS-PENDING"
)

// Verdict maps a driver result to an outcome. FAIL and XPASS fail CI.
func Verdict(fixtureID, driver string, x *XFail, failures []string) (Outcome, string) {
	switch {
	case x == nil && len(failures) == 0:
		return OutcomePass, ""
	case x == nil:
		return OutcomeFail, fmt.Sprintf("%s/%s failed: %v", fixtureID, driver, failures)
	case len(failures) > 0:
		return OutcomeXFail, ""
	default:
		return OutcomeXPass, fmt.Sprintf("fixture %s now passes on %s: remove its xfail tag (ref %s)", fixtureID, driver, x.Issue)
	}
}

// VerdictPending judges a part that also has harness-pending keys.
// pending lists the unevaluated keys the part's blocks use.
//
//   - no pending keys: Verdict.
//   - not xfail: FAIL (a pass with unchecked keys is not a pass).
//   - xfail with only pending (no real product failure): HARNESS-PENDING,
//     which fails CI: the xfail would rest on the harness gap alone.
//   - xfail with real failures as well: XFAIL; the pending keys are
//     still listed in the message so the gap stays visible.
func VerdictPending(fixtureID, driver string, x *XFail, failures, pending []string) (Outcome, string) {
	if len(pending) == 0 {
		return Verdict(fixtureID, driver, x, failures)
	}
	switch {
	case x == nil:
		return OutcomeFail, fmt.Sprintf("%s/%s: not evaluated by the harness yet: %v (failures: %v)", fixtureID, driver, pending, failures)
	case len(failures) == 0:
		return OutcomePending, fmt.Sprintf("%s/%s: xfail (%s) rests only on harness-pending keys %v: implement them or show a real product failure", fixtureID, driver, x.Issue, pending)
	default:
		return OutcomeXFail, fmt.Sprintf("harness-pending keys (not counted): %v", pending)
	}
}

// Failing reports whether an outcome fails CI.
func (o Outcome) Failing() bool {
	return o == OutcomeFail || o == OutcomeXPass || o == OutcomePending
}
