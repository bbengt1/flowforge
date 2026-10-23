package workflow

import (
	"strings"
	"testing"
	"time"
)

// #650 E3.3: FFX runtime in data.map and flow.condition.

func coreExprDoc(mapExpr, condExpr string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ffx-core
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      with:
        value:
          total: 5
    - id: shape
      type: data.map
      name: Shape
      with:
        expr: {expr: '` + mapExpr + `'}
    - id: gate
      type: flow.condition
      name: Gate
      with:
        expr: {expr: '` + condExpr + `'}
  edges:
    - from: constants.result
      to: shape.input
    - from: shape.result
      to: gate.value
`
}

func TestCoreExprPublishCheck650(t *testing.T) {
	res, errs := ParseAndNormalize([]byte(coreExprDoc(`{"double": item.total * 2}`, `item.double > 4`)))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	rep, cerrs := CheckExpressions(res.Document)
	if len(cerrs) > 0 || len(rep.Refs) != 2 {
		t.Fatalf("refs=%+v errs=%v", rep.Refs, cerrs)
	}
	// A condition expression that is not boolean fails publish.
	res, errs = ParseAndNormalize([]byte(coreExprDoc(`{"a": 1}`, `"yes"`)))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	if _, cerrs := CheckExpressions(res.Document); len(cerrs) != 1 || cerrs[0].Code != CodeExpressionType || cerrs[0].NodeID != "gate" {
		t.Fatalf("errs=%v", cerrs)
	}
	// vars is refused in both fields: neither takes a credential ref.
	res, _ = ParseAndNormalize([]byte(coreExprDoc(`vars.k`, `true`)))
	if _, cerrs := CheckExpressions(res.Document); len(cerrs) != 1 || cerrs[0].Code != CodeExpressionSecretUse {
		t.Fatalf("errs=%v", cerrs)
	}
}

func TestCoreExprShapeValidation650(t *testing.T) {
	bad := strings.Replace(coreExprDoc(`{"a": 1}`, `true`), "        expr: {expr: '{\"a\": 1}'}", "        expr: {expr: '{\"a\": 1}'}\n        mapping: {a: total}", 1)
	if _, errs := ParseAndNormalize([]byte(bad)); len(errs) == 0 {
		t.Fatal("expr + mapping accepted")
	}
	noOp := strings.Replace(coreExprDoc(`{"a": 1}`, `true`), "        expr: {expr: 'true'}", "        compare: 1", 1)
	if _, errs := ParseAndNormalize([]byte(noOp)); len(errs) == 0 {
		t.Fatal("condition with neither op nor expr accepted")
	}
}

func rc(node string) *RunContext {
	clk := time.Date(2026, 10, 15, 18, 0, 0, 0, time.UTC)
	return &RunContext{NodeID: node, RunID: "r1", Clock: &clk, StartedAt: clk}
}

func TestDataMapExprRuntime650(t *testing.T) {
	with := map[string]any{"expr": map[string]any{"expr": `{"double": item.total * 2, "at": run.clock}`}}
	out := EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{"total": int64(5)}}, nil, rc("shape"), "")
	if out.Fail {
		t.Fatalf("%+v", out)
	}
	got := out.Output["result"].(map[string]any)
	if got["double"] != int64(10) || got["at"] != "2026-10-15T18:00:00Z" {
		t.Fatalf("%v", got)
	}
	// JSON-decoded numbers (float64) behave like integers.
	js := EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{"total": float64(5)}}, nil, rc("shape"), "")
	if js.Fail || js.Output["result"].(map[string]any)["double"] != int64(10) {
		t.Fatalf("%+v", js)
	}
	// Same attempt clock, same result.
	again := EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{"total": int64(5)}}, nil, rc("shape"), "")
	if again.Output["result"].(map[string]any)["at"] != got["at"] {
		t.Fatal("run.clock not deterministic")
	}
}

// A value whose type is only known at runtime fails closed, names the
// nodeId and never echoes the value or the expression.
func TestCoreExprRuntimeTypeFailsClosed650(t *testing.T) {
	secret := "hunter2-value"
	for _, tc := range []struct {
		node, typ, src string
		in             map[string]any
	}{
		{"shape", "data.map", `item.v`, map[string]any{"input": map[string]any{"v": secret}}},
		{"gate", "flow.condition", `item.v`, map[string]any{"value": map[string]any{"v": secret}}},
		{"gate", "flow.condition", `item.v > 1`, map[string]any{"value": map[string]any{"v": secret}}},
		{"gate", "flow.condition", `item.v == 1`, map[string]any{"value": secret}},
	} {
		with := map[string]any{"expr": map[string]any{"expr": tc.src}}
		out := EvaluateStepRun(tc.typ, with, tc.in, nil, rc(tc.node), "")
		if !out.Fail || !strings.HasPrefix(out.Code, "expression-") {
			t.Fatalf("%s %q: %+v", tc.typ, tc.src, out)
		}
		if !strings.Contains(out.Message, `"`+tc.node+`"`) {
			t.Fatalf("message does not name node: %s", out.Message)
		}
		if strings.Contains(out.Message, secret) || strings.Contains(out.Message, tc.src) {
			t.Fatalf("message echoes: %s", out.Message)
		}
	}
}

func TestCoreExprFailsClosedWithoutRunContext650(t *testing.T) {
	with := map[string]any{"expr": map[string]any{"expr": `true`}}
	out := EvaluateStep("flow.condition", with, map[string]any{"value": 1}, nil)
	if !out.Fail || out.Code != CodeExpressionRuntime {
		t.Fatalf("%+v", out)
	}
}

func TestDataMapExprReservedKey650(t *testing.T) {
	with := map[string]any{"expr": map[string]any{"expr": `{"__ff_items": 1}`}}
	out := EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{}}, nil, rc("shape"), "")
	if !out.Fail || out.Code != CodeExpressionRuntime {
		t.Fatalf("%+v", out)
	}
}

func TestConditionExprRoutes650(t *testing.T) {
	with := map[string]any{"expr": map[string]any{"expr": `'k' in item && item.k > 2`}}
	out := EvaluateStepRun("flow.condition", with, map[string]any{"value": map[string]any{"k": int64(3)}}, nil, rc("gate"), "")
	if out.Fail || out.Output["port"] != "true" {
		t.Fatalf("%+v", out)
	}
	out = EvaluateStepRun("flow.condition", with, map[string]any{"value": map[string]any{}}, nil, rc("gate"), "")
	if out.Fail || out.Output["port"] != "false" {
		t.Fatalf("%+v", out)
	}
}

// Terry's E3.2 smoke: has() through the real publish checker on a core
// node carries the 'k' in m hint, names the node and echoes nothing.
func TestPublishCheckerPresenceHint650(t *testing.T) {
	res, errs := ParseAndNormalize([]byte(coreExprDoc(`{"a": 1}`, `has(item.zqHidden)`)))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	_, cerrs := CheckExpressions(res.Document)
	if len(cerrs) != 1 || cerrs[0].Code != CodeExpressionParse || cerrs[0].NodeID != "gate" || !strings.Contains(cerrs[0].Message, "'k' in m") {
		t.Fatalf("errs=%v", cerrs)
	}
	if strings.Contains(cerrs[0].Message, "zqHidden") {
		t.Fatal("echoed")
	}
}

// L1: trigger and items are refused at publish in core-node expressions
// with a fixed "not available yet" error that names the node only.
func TestCoreExprTriggerNotAvailable650(t *testing.T) {
	res, errs := ParseAndNormalize([]byte(coreExprDoc(`{"a": trigger.zqSecret}`, `true`)))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	_, cerrs := CheckExpressions(res.Document)
	if len(cerrs) != 1 || cerrs[0].Code != CodeExpressionRefUnknown || cerrs[0].NodeID != "shape" || !strings.Contains(cerrs[0].Message, "not available yet") {
		t.Fatalf("errs=%v", cerrs)
	}
	if strings.Contains(cerrs[0].Message, "zqSecret") {
		t.Fatal("echoed")
	}
}

func TestCoreExprItemsNotAvailable650(t *testing.T) {
	res, errs := ParseAndNormalize([]byte(coreExprDoc(`{"a": 1}`, `size(items) > 0`)))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	_, cerrs := CheckExpressions(res.Document)
	if len(cerrs) != 1 || cerrs[0].Code != CodeExpressionRefUnknown || cerrs[0].NodeID != "gate" || !strings.Contains(cerrs[0].Message, "not available yet") {
		t.Fatalf("errs=%v", cerrs)
	}
}

// L3: the reserved-key check is top-level only; a nested __ff_ key is
// ordinary user data.
func TestDataMapExprNestedReservedKeyAllowed650(t *testing.T) {
	with := map[string]any{"expr": map[string]any{"expr": `{"wrap": {"__ff_items": 1}}`}}
	out := EvaluateStepRun("data.map", with, map[string]any{"input": map[string]any{}}, nil, rc("shape"), "")
	if out.Fail {
		t.Fatalf("%+v", out)
	}
	if out.Output["result"].(map[string]any)["wrap"].(map[string]any)["__ff_items"] != int64(1) {
		t.Fatalf("%+v", out.Output)
	}
}
