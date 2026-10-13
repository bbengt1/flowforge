package wfstore

import (
	"strings"
	"testing"
)

func TestRoutableFailureAllowlist649(t *testing.T) {
	fail := ExecutionStep{NodeType: "flow.fail", Input: map[string]any{"code": "team.reason"}}
	other := ExecutionStep{NodeType: "http.request", Input: map[string]any{"code": "team.reason"}}
	cases := []struct {
		step ExecutionStep
		code string
		want bool
	}{
		{fail, "team.reason", true},
		{fail, "team.other", false},     // not the step's own code
		{other, "team.reason", false},   // dotted codes only from flow.fail
		{fail, "egress-denied", false},  // flow.fail imitating a security code
		{other, "timeout", true},        // allowlisted runtime failure
		{other, "command-failed", true}, // ssh.run
		{other, "apply-failed", true},   // kubernetes.*
		{other, "script-failed", true},
		{other, "unknown-new-code", false},
	}
	for _, c := range cases {
		if got := routableFailure(c.step, map[string]any{"code": c.code}); got != c.want {
			t.Errorf("%s %q = %v, want %v", c.step.NodeType, c.code, got, c.want)
		}
	}
	for _, code := range neverRoutedCodes {
		steps := []ExecutionStep{fail, other}
		if !strings.Contains(code, ".") {
			// flow.fail whose own with.code is a system-looking label.
			steps = append(steps, ExecutionStep{NodeType: "flow.fail", Input: map[string]any{"code": code}})
		}
		for _, st := range steps {
			if routableFailure(st, map[string]any{"code": code}) {
				t.Errorf("security/unknown code %q routed on %s", code, st.NodeType)
			}
		}
	}
	if routableFailure(fail, map[string]any{}) || routableFailure(fail, nil) {
		t.Error("missing code routed")
	}
}

func TestErrorPortPayloadCapsCode649(t *testing.T) {
	long := strings.Repeat("c", 200)
	p := errorPortPayload(ExecutionStep{NodeID: "boom", Attempt: 2}, map[string]any{"code": long, "message": "m", "extra": "x"})
	if len(p) != 4 {
		t.Fatalf("payload keys = %v", p)
	}
	if c, _ := p["code"].(string); len(c) != errorPortCodeMax {
		t.Fatalf("code len = %d", len(c))
	}
}
