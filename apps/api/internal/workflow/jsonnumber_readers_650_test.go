package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/expr"
)

// #650 E3.3 review L1: readers that used to see only float64 get an exact
// json.Number for a whole number outside ±2^53 and handle it exactly.

const bigLit = "9007199254740993" // 2^53+1, exact as a json.Number only

func TestConditionOrderedOpsOnBigJSONNumber650(t *testing.T) {
	big := json.Number(bigLit)
	value := map[string]any{"n": big}
	cases := []struct {
		op      string
		compare any
		want    string
	}{
		// 2^53 as an int64 and as a float64 is below 2^53+1; float64
		// rounding would have made these equal.
		{"gt", int64(1 << 53), "true"},
		{"gt", float64(1 << 53), "true"},
		{"gte", int64(1 << 53), "true"},
		{"lt", int64(1 << 53), "false"},
		{"lte", int64(1 << 53), "false"},
		{"gt", json.Number("9007199254740994"), "false"},
		{"lt", json.Number("9007199254740994"), "true"},
		{"lte", big, "true"},
		{"gte", big, "true"},
		{"gt", big, "false"},
		{"eq", big, "true"},
		{"eq", int64(1 << 53), "false"},
		{"ne", float64(1 << 53), "true"},
	}
	for _, c := range cases {
		with := map[string]any{"op": c.op, "compare": c.compare, "path": "n"}
		out := EvaluateStep("flow.condition", with, map[string]any{"value": value}, nil)
		if out.Fail || out.Output["port"] != c.want {
			t.Fatalf("%s %v: %+v", c.op, c.compare, out)
		}
	}
	// Too large to compare exactly: a fixed error naming the field only.
	huge := json.Number(strings.Repeat("9", 500))
	out := EvaluateStep("flow.condition", map[string]any{"op": "gt", "compare": int64(1), "path": "n"}, map[string]any{"value": map[string]any{"n": huge}}, nil)
	if !out.Fail || !strings.Contains(out.Message, "too large to compare exactly") || strings.Contains(out.Message, "999999") {
		t.Fatalf("%+v", out)
	}
}

func TestMappingConvertBigJSONNumber650(t *testing.T) {
	with := map[string]any{"mapping": map[string]any{
		"i": map[string]any{"from": "n", "convert": "integer"},
		"s": map[string]any{"from": "n", "convert": "string"},
	}}
	out := EvaluateStep("data.map", with, map[string]any{"input": map[string]any{"n": json.Number(bigLit)}}, nil)
	if out.Fail {
		t.Fatalf("%+v", out)
	}
	res := out.Output["result"].(map[string]any)
	if res["i"] != int64(9007199254740993) || res["s"] != bigLit {
		t.Fatalf("%#v", res)
	}
	// Outside int64: refused by the fixed conversion error, never rounded.
	with = map[string]any{"mapping": map[string]any{"i": map[string]any{"from": "n", "convert": "integer"}}}
	out = EvaluateStep("data.map", with, map[string]any{"input": map[string]any{"n": json.Number("123456789012345678901234567890")}}, nil)
	if !out.Fail || out.Code != CodeInvalidType || strings.Contains(out.Message, "1234567890") {
		t.Fatalf("%+v", out)
	}
}

func TestSchemaBigJSONNumber650(t *testing.T) {
	b := *defaultNeutralBounds()
	big := json.Number(bigLit)
	// Typed integer and number accept it.
	for _, typ := range []string{"integer", "number"} {
		if _, errs := validateAgainstSchema(big, map[string]any{"type": typ}, "v", b); len(errs) > 0 {
			t.Fatalf("%s: %v", typ, errs)
		}
	}
	if _, errs := validateAgainstSchema(json.Number("123456789012345678901234567890"), map[string]any{"type": "integer"}, "v", b); len(errs) > 0 {
		t.Fatalf("beyond int64: %v", errs)
	}
	// minimum/maximum compare exactly against 2^53.
	if _, errs := validateAgainstSchema(big, map[string]any{"type": "integer", "maximum": int64(1 << 53)}, "v", b); len(errs) != 1 || !strings.Contains(errs[0].Message, "above schema.maximum") {
		t.Fatalf("max: %v", errs)
	}
	if _, errs := validateAgainstSchema(big, map[string]any{"type": "integer", "minimum": json.Number("9007199254740994")}, "v", b); len(errs) != 1 || !strings.Contains(errs[0].Message, "below schema.minimum") {
		t.Fatalf("min: %v", errs)
	}
	if _, errs := validateAgainstSchema(big, map[string]any{"minimum": big, "maximum": big}, "v", b); len(errs) > 0 {
		t.Fatalf("equal bounds: %v", errs)
	}
	if _, errs := validateAgainstSchema(big, map[string]any{"enum": []any{int64(9007199254740993)}}, "v", b); len(errs) > 0 {
		t.Fatalf("enum: %v", errs)
	}
	huge := json.Number(strings.Repeat("9", 500))
	_, errs := validateAgainstSchema(huge, map[string]any{"maximum": int64(1)}, "v", b)
	if len(errs) != 1 || !strings.Contains(errs[0].Message, "too large to compare exactly") || strings.Contains(errs[0].Message, "999") || errs[0].Path != "v" {
		t.Fatalf("huge: %v", errs)
	}
}

func TestAsInt64AsFloat64JSONNumber650(t *testing.T) {
	if n, ok := asInt64(json.Number(bigLit)); !ok || n != 9007199254740993 {
		t.Fatalf("asInt64 %d %v", n, ok)
	}
	if _, ok := asInt64(json.Number("123456789012345678901234567890")); ok {
		t.Fatal("asInt64 beyond int64")
	}
	if _, ok := asFloat64(json.Number(bigLit)); ok {
		t.Fatal("asFloat64 rounded an inexact value")
	}
	if f, ok := asFloat64(json.Number("9007199254740994")); !ok || f != 9007199254740994 {
		t.Fatalf("asFloat64 exact %v %v", f, ok)
	}
}

// An integer-kind input port fed a big exact value reads it exactly.
func TestExprIntegerPortBigValue650(t *testing.T) {
	sc := expr.Scope{Mode: expr.ModePerItem, Declared: map[string]expr.Kind{"n": expr.KindInteger}, Wired: map[string]expr.Kind{"n": expr.KindInteger}, Want: expr.KindString}
	got, err := expr.Eval(context.Background(), `string(input.n)`, sc, expr.Env{Inputs: map[string]any{"n": json.Number(bigLit)}})
	if err != nil || got != bigLit {
		t.Fatalf("%v %v", got, err)
	}
}
