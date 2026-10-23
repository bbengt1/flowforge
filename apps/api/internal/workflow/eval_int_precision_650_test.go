package workflow

import (
	"encoding/json"
	"strings"
	"testing"
)

// #650 E3.3 QA M1: a whole number outside ±2^53 in an expression result
// fails the step closed (it would be rounded through float64 on the way to
// storage). The error names the nodeId only and never echoes the value.

func TestExprResultIntPrecision650(t *testing.T) {
	big := float64(9007199254740991) // 2^53-1, as JSON decodes it
	in := map[string]any{"input": map[string]any{"big": big}}
	run := func(src string) StepOutcome {
		with := map[string]any{"expr": map[string]any{"expr": src}}
		return EvaluateStepRun("data.map", with, in, nil, rc("shape"))
	}
	refused := []string{
		`{"v": item.big + 2, "s": string(item.big + 2)}`, // Terry's arithmetic case
		`{"v": 9007199254740993}`,                        // literal
		`{"v": 9007199254740993, "s": "9007199254740993"}`,
		`{"v": -9007199254740993}`,
		`{"v": 9007199254740993u}`, // uint
		`{"v": 18446744073709551615u}`,
		`{"v": 9223372036854775807}`,
		`{"deep": {"list": [1, [2, {"n": item.big + 2}]]}}`, // any depth
	}
	for _, src := range refused {
		out := run(src)
		if !out.Fail || out.Code != CodeExpressionRuntime {
			t.Fatalf("%s: %+v", src, out)
		}
		if !strings.Contains(out.Message, `"shape"`) {
			t.Fatalf("%s: message does not name the node: %s", src, out.Message)
		}
		for _, leak := range []string{"9007199254740993", "9007199254740992", "18446744073709551615", "9223372036854775807", "item.big", src} {
			if strings.Contains(out.Message, leak) {
				t.Fatalf("%s: message echoes %q: %s", src, leak, out.Message)
			}
		}
		raw, _ := json.Marshal(out)
		if strings.Contains(string(raw), "9007199254740993") {
			t.Fatalf("%s: outcome echoes the value: %s", src, raw)
		}
	}
	allowed := map[string]int64{
		`{"v": 9007199254740992}`:  1 << 53,
		`{"v": -9007199254740992}`: -(1 << 53),
		`{"v": item.big + 1}`:      1 << 53,
		`{"v": item.big}`:          (1 << 53) - 1,
		`{"v": 9007199254740992u}`: 1 << 53,
	}
	for src, want := range allowed {
		out := run(src)
		if out.Fail {
			t.Fatalf("%s: %+v", src, out)
		}
		if got := out.Output["result"].(map[string]any)["v"]; got != want {
			t.Fatalf("%s: got %v want %d", src, got, want)
		}
	}
	// string() keeps every digit and is allowed.
	out := run(`{"s": string(item.big + 2)}`)
	if out.Fail || out.Output["result"].(map[string]any)["s"] != "9007199254740993" {
		t.Fatalf("%+v", out)
	}
}

// A whole number outside ±2^53 kept exact by the store (json.Number)
// reads exactly; one outside int64 fails closed. flow.condition shares the
// path.
func TestExprExactBigInput650(t *testing.T) {
	exact := json.Number("9007199254740993")
	with := map[string]any{"expr": map[string]any{"expr": `{"s": string(item.big)}`}}
	out := EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{"big": exact}}, nil, rc("shape"))
	if out.Fail || out.Output["result"].(map[string]any)["s"] != "9007199254740993" {
		t.Fatalf("%+v", out)
	}
	// Passed straight through as a number it is refused, not rounded.
	with = map[string]any{"expr": map[string]any{"expr": `{"v": item.big}`}}
	out = EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{"big": exact}}, nil, rc("shape"))
	if !out.Fail || out.Code != CodeExpressionRuntime || strings.Contains(out.Message, string(exact)) {
		t.Fatalf("%+v", out)
	}
	cond := map[string]any{"expr": map[string]any{"expr": `item.big == 9007199254740993`}}
	out = EvaluateStepRun("flow.condition", cond, map[string]any{"value": map[string]any{"big": exact}}, nil, rc("gate"))
	if out.Fail || out.Output["port"] != "true" {
		t.Fatalf("%+v", out)
	}
	huge := json.Number("123456789012345678901234567890")
	out = EvaluateStepRun("flow.condition", cond, map[string]any{"value": map[string]any{"big": huge}}, nil, rc("gate"))
	if !out.Fail || out.Code != CodeExpressionRuntime || !strings.Contains(out.Message, `"gate"`) || strings.Contains(out.Message, string(huge)) {
		t.Fatalf("%+v", out)
	}
}

// QA M2 at the parser: only with.expr source on expression-capable node
// types skips the template check.
func TestExprSourceSkipsTemplateCheck650(t *testing.T) {
	for _, src := range []string{`{"a": {"b": 1}}`, `{"s": "}}"}`, `{"s": "{{ x }}", "t": "${y} <% %>"}`} {
		if _, errs := ParseAndNormalize([]byte(coreExprDoc(src, `true`))); len(errs) > 0 {
			t.Fatalf("%s: %v", src, errs)
		}
	}
	if _, errs := ParseAndNormalize([]byte(coreExprDoc(`{"a": 1}`, `{"k": {"v": "}}"}}.k.v == "}}"`))); len(errs) > 0 {
		t.Fatalf("condition: %v", errs)
	}
	for _, bad := range []string{
		strings.Replace(coreExprDoc(`{"a": 1}`, `true`), "        expr: {expr: '{\"a\": 1}'}", "        mapping: {a: '{{ total }}'}", 1),
		strings.Replace(coreExprDoc(`{"a": 1}`, `true`), "        expr: {expr: '{\"a\": 1}'}", "        mapping: {a: 'total }}'}", 1),
		strings.Replace(coreExprDoc(`{"a": 1}`, `true`), "        expr: {expr: 'true'}", "        op: eq\n        compare: x\n        path: '{{ a }}'", 1),
		strings.Replace(coreExprDoc(`{"a": 1}`, `true`), "          total: 5", "          expr: '}}'", 1),
	} {
		_, errs := ParseAndNormalize([]byte(bad))
		if len(errs) == 0 || errs[0].Code != CodeTemplateForbidden {
			t.Fatalf("accepted or wrong code: %v\n%s", errs, bad)
		}
	}
}
