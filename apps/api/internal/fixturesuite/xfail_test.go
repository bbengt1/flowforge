package fixturesuite

import "fmt"

// Outcome is a fixture driver's strict-xfail verdict.
type Outcome string

const (
	OutcomePass  Outcome = "PASS"
	OutcomeFail  Outcome = "FAIL"
	OutcomeXFail Outcome = "XFAIL"
	OutcomeXPass Outcome = "XPASS"
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

// Failing reports whether an outcome fails CI.
func (o Outcome) Failing() bool { return o == OutcomeFail || o == OutcomeXPass }
