//go:build fftest

package workflow

import "testing"

func flakyDoc(with string) string {
	return `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: flaky
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: flaky
      type: test.flaky
      name: Flaky
      with:
` + with + "\n  edges: []\n"
}

func TestFlakyRegisteredUnderFFTest(t *testing.T) {
	if !IsTestNode("test.flaky") {
		t.Fatal("test.flaky must be registered with -tags fftest")
	}
	for _, w := range []string{"        failTimes: 2", "        failTimes: 0", "        mode: alwaysFail"} {
		if _, errs := Parse([]byte(flakyDoc(w))); len(errs) > 0 {
			t.Fatalf("%q: %+v", w, errs)
		}
	}
	for w, code := range map[string]string{
		"        failTimes: 11":                          CodeInvalidWith,
		"        failTimes: -1":                          CodeInvalidWith,
		"        mode: sometimes":                        CodeInvalidWith,
		"        failTimes: 1\n        mode: alwaysFail": CodeInvalidWith,
		"        other: 1":                               CodeUnknownField,
	} {
		_, errs := Parse([]byte(flakyDoc(w)))
		assertHasCode(t, errs, code)
	}
}

func TestFlakyDeterministicByAttempt(t *testing.T) {
	with := map[string]any{"failTimes": float64(2)} // JSON round-trip shape
	for attempt, wantFail := range map[int]bool{1: true, 2: true, 3: false, 4: false} {
		for i := 0; i < 3; i++ { // same input, same answer every time
			out := EvaluateTestStep("test.flaky", with, attempt)
			if out.Fail != wantFail {
				t.Fatalf("attempt %d fail=%v", attempt, out.Fail)
			}
			if out.Fail && out.Code != CodeTestFlakyFailure {
				t.Fatalf("code %s", out.Code)
			}
			if !out.Fail && out.Output["result"].(map[string]any)["attempt"] != attempt {
				t.Fatalf("output %+v", out.Output)
			}
		}
	}
	for attempt := 1; attempt <= 6; attempt++ {
		if !EvaluateTestStep("test.flaky", map[string]any{"mode": "alwaysFail"}, attempt).Fail {
			t.Fatalf("alwaysFail passed on attempt %d", attempt)
		}
	}
	if EvaluateTestStep("test.flaky", map[string]any{"failTimes": 0}, 1).Fail {
		t.Fatal("failTimes 0 must succeed")
	}
	if n := CoreCatalog().Nodes; len(n) == 0 {
		t.Fatal("catalog empty")
	}
}
