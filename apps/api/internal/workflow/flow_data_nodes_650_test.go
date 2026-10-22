package workflow

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// #650 E3.4: flow.switch, data.filter, data.sort, data.merge.

func switchDoc(withDefault bool) string {
	def := "        default: other\n"
	edge := "    - {from: route.other, to: out-other.input}\n"
	if !withDefault {
		def, edge = "", ""
	}
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e34-switch
spec:
  triggers:
    - {id: manual, type: manual}
  nodes:
    - {id: seed, type: data.set, name: Seed, with: {value: {tier: gold}}}
    - id: route
      type: flow.switch
      name: Route
      with:
        path: tier
        cases:
          - {name: bronze, op: eq, compare: bronze}
          - {name: gold, op: eq, compare: gold}
` + def + `    - {id: out-bronze, type: flow.stop, name: B, with: {status: success}}
    - {id: out-gold, type: flow.stop, name: G, with: {status: success}}
    - {id: out-other, type: flow.stop, name: O, with: {status: success}}
  edges:
    - {from: seed.result, to: route.value}
    - {from: route.bronze, to: out-bronze.input}
    - {from: route.gold, to: out-gold.input}
` + edge
}

func hasCodeAt(errs ErrorList, code, pathPart string) bool {
	for _, e := range errs {
		if e.Code == code && strings.Contains(e.Path, pathPart) {
			return true
		}
	}
	return false
}

func TestSwitchPublish650E34(t *testing.T) {
	if _, errs := ParseAndNormalize([]byte(switchDoc(true))); len(errs) > 0 {
		t.Fatalf("valid switch refused: %v", errs)
	}
	// Gracie check 1 (publish): default is required.
	_, errs := ParseAndNormalize([]byte(strings.Replace(switchDoc(false), "    - {id: out-other, type: flow.stop, name: O, with: {status: success}}\n", "", 1)))
	if !hasCodeAt(errs, CodeMissingField, "with.default") {
		t.Fatalf("switch without default accepted: %v", errs)
	}
	// An edge from an undeclared case port is refused.
	bad := strings.Replace(switchDoc(true), "route.gold, to: out-gold", "route.silver, to: out-gold", 1)
	if _, errs := ParseAndNormalize([]byte(bad)); !hasCodeAt(errs, CodeInvalidPort, "edges") {
		t.Fatalf("unknown case port accepted: %v", errs)
	}
	for name, repl := range map[string]string{
		"duplicate":  "{name: gold, op: eq, compare: bronze}",
		"reserved":   "{name: port, op: eq, compare: bronze}",
		"engine":     "{name: __ff_items, op: eq, compare: bronze}",
		"bad op":     "{name: bronze, op: like, compare: bronze}",
		"no compare": "{name: bronze, op: eq}",
		"expression": "{name: bronze, op: eq, compare: '${x}'}",
	} {
		doc := strings.Replace(switchDoc(true), "{name: bronze, op: eq, compare: bronze}", repl, 1)
		if _, errs := ParseAndNormalize([]byte(doc)); len(errs) == 0 {
			t.Fatalf("%s: accepted", name)
		}
	}
	dupDefault := strings.Replace(switchDoc(true), "default: other", "default: gold", 1)
	if _, errs := ParseAndNormalize([]byte(dupDefault)); !hasCodeAt(errs, CodeDuplicateID, "with.default") {
		t.Fatalf("default equal to a case accepted: %v", errs)
	}
}

func switchWith(def bool) map[string]any {
	w := map[string]any{
		"path": "tier",
		"cases": []any{
			map[string]any{"name": "bronze", "op": "eq", "compare": "bronze"},
			map[string]any{"name": "gold", "op": "eq", "compare": "gold"},
			map[string]any{"name": "gold2", "op": "eq", "compare": "gold"},
		},
	}
	if def {
		w["default"] = "other"
	}
	return w
}

func TestSwitchRuntime650E34(t *testing.T) {
	route := func(v any, def bool) StepOutcome {
		return EvaluateStep("flow.switch", switchWith(def), map[string]any{"value": map[string]any{"tier": v}}, nil)
	}
	// The first matching case wins and exactly one port is emitted.
	out := route("gold", true)
	if out.Fail || out.Output["port"] != "gold" || out.Output["gold"] == nil || out.Output["gold2"] != nil {
		t.Fatalf("%+v", out)
	}
	ports := 0
	for k := range out.Output {
		if k != "port" {
			ports++
		}
	}
	if ports != 1 {
		t.Fatalf("emitted %d ports: %+v", ports, out.Output)
	}
	if out := route("tin", true); out.Fail || out.Output["port"] != "other" {
		t.Fatalf("%+v", out)
	}
	// A missing path goes to default (no case matches).
	o := EvaluateStep("flow.switch", switchWith(true), map[string]any{"value": map[string]any{}}, nil)
	if o.Fail || o.Output["port"] != "other" {
		t.Fatalf("%+v", o)
	}
	// Exact big-number comparison: 2^53+1 > 2^53 (equal as float64).
	num := map[string]any{"path": "n", "default": "small", "cases": []any{
		map[string]any{"name": "big", "op": "gt", "compare": json.Number("9007199254740992")},
	}}
	for v, want := range map[string]string{"9007199254740993": "big", "9007199254740992": "small"} {
		o := EvaluateStep("flow.switch", num, map[string]any{"value": map[string]any{"n": json.Number(v)}}, nil)
		if o.Fail || o.Output["port"] != want {
			t.Fatalf("%s: %+v", v, o)
		}
	}
	// A case that cannot compare its subject fails closed (as in
	// flow.condition); it is not skipped.
	if o := EvaluateStep("flow.switch", num, map[string]any{"value": map[string]any{"n": "x"}}, nil); !o.Fail || o.Code != CodeInvalidType {
		t.Fatalf("%+v", o)
	}
	// Gracie check 1 (runtime): no match and no default fails closed.
	nd := route("tin", false)
	if !nd.Fail || nd.Code != CodeSwitchNoMatch || nd.Output != nil {
		t.Fatalf("%+v", nd)
	}
	if strings.Contains(nd.Message, "tin") {
		t.Fatalf("message echoes the value: %q", nd.Message)
	}
	// A matching case still routes without a default.
	if out := route("gold", false); out.Fail || out.Output["port"] != "gold" {
		t.Fatalf("%+v", out)
	}
}

func items(ms ...map[string]any) map[string]any {
	l := make([]any, len(ms))
	for i, m := range ms {
		l[i] = m
	}
	return map[string]any{"items": l}
}

func itemList(t *testing.T, v any) []map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("port value %T", v)
	}
	l := m["items"].([]any)
	out := make([]map[string]any, len(l))
	for i, it := range l {
		out[i] = it.(map[string]any)
	}
	return out
}

func ids(t *testing.T, v any) []any {
	var out []any
	for _, it := range itemList(t, v) {
		out = append(out, it["id"])
	}
	return out
}

func eqIDs(got []any, want ...any) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if !valuesEqual(got[i], want[i]) {
			return false
		}
	}
	return true
}

func TestFilterDeclarative650E34(t *testing.T) {
	in := items(
		map[string]any{"id": 1, "n": 5},
		map[string]any{"id": 2, "n": 1},
		map[string]any{"id": 3},
		map[string]any{"id": 4, "n": json.Number("9007199254740993")},
	)
	out := EvaluateStep("data.filter", map[string]any{"path": "n", "op": "gt", "compare": 2}, map[string]any{"input": in}, nil)
	if out.Fail {
		t.Fatalf("%+v", out)
	}
	if got := ids(t, out.Output["kept"]); !eqIDs(got, 1, 4) {
		t.Fatalf("kept %v", got)
	}
	if got := ids(t, out.Output["dropped"]); !eqIDs(got, 2, 3) {
		t.Fatalf("dropped %v", got)
	}
	// Both ports fire: no routing key.
	if _, ok := out.Output["port"]; ok {
		t.Fatal("filter set a routing port")
	}
	// An object reads as one item.
	one := EvaluateStep("data.filter", map[string]any{"op": "exists", "path": "id"}, map[string]any{"input": map[string]any{"id": 9}}, nil)
	if one.Fail || len(itemList(t, one.Output["kept"])) != 1 {
		t.Fatalf("%+v", one)
	}
	// A non-object item fails closed.
	bad := EvaluateStep("data.filter", map[string]any{"op": "exists", "path": "id"}, map[string]any{"input": map[string]any{"items": []any{1}}}, nil)
	if !bad.Fail || bad.Code != CodeInvalidType {
		t.Fatalf("%+v", bad)
	}
}

func TestFilterExpr650E34(t *testing.T) {
	with := map[string]any{"expr": map[string]any{"expr": `item.n > 2`}}
	in := map[string]any{"input": items(map[string]any{"id": 1, "n": int64(5)}, map[string]any{"id": 2, "n": float64(1)})}
	out := EvaluateStepRun("data.filter", with, in, nil, rc("f"))
	if out.Fail || !eqIDs(ids(t, out.Output["kept"]), 1) || !eqIDs(ids(t, out.Output["dropped"]), 2) {
		t.Fatalf("%+v", out)
	}
	// Outside a run attempt an expr fails closed.
	if o := EvaluateStep("data.filter", with, in, nil); !o.Fail || o.Code != CodeExpressionRuntime {
		t.Fatalf("%+v", o)
	}
	// 2^53+1 binds as an exact int64 and compares exactly.
	exact := EvaluateStepRun("data.filter", map[string]any{"expr": map[string]any{"expr": `item.n == 9007199254740993`}},
		map[string]any{"input": items(map[string]any{"id": 1, "n": json.Number("9007199254740993")}, map[string]any{"id": 2, "n": json.Number("9007199254740992")})}, nil, rc("f"))
	if exact.Fail || !eqIDs(ids(t, exact.Output["kept"]), 1) {
		t.Fatalf("%+v", exact)
	}
	// A whole number CEL cannot hold exactly fails closed, never rounded.
	big := map[string]any{"input": items(map[string]any{"id": 1, "n": json.Number("99999999999999999999")})}
	if o := EvaluateStepRun("data.filter", with, big, nil, rc("f")); !o.Fail || o.Code != CodeExpressionRuntime {
		t.Fatalf("%+v", o)
	} else if strings.Contains(o.Message, "99999999999999999999") {
		t.Fatalf("message echoes the value: %q", o.Message)
	}
	// A non-boolean result fails closed.
	nb := map[string]any{"expr": map[string]any{"expr": `item.n`}}
	if o := EvaluateStepRun("data.filter", nb, in, nil, rc("f")); !o.Fail {
		t.Fatalf("%+v", o)
	}
}

// Gracie check 4: every CEL program is built through newProgram with
// ProgramOptions(). internal/expr's guard test refuses any other
// .Program( call and any cel-go import outside internal/expr; this pins
// that the E3.4 nodes reach CEL only through evalFieldExpr.
func TestE34NodesUseEvalFieldExpr(t *testing.T) {
	src, err := os.ReadFile("flow_data_nodes.go")
	if err != nil {
		t.Fatal(err)
	}
	s := string(src)
	if strings.Contains(s, "cel-go") || strings.Contains(s, ".Program(") || strings.Contains(s, "expr.Eval(") {
		t.Fatal("E3.4 nodes must evaluate FFX only through evalFieldExpr")
	}
	if !strings.Contains(s, `prepareFieldExpr("data.filter", "expr"`) {
		t.Fatal("data.filter expr does not go through evalFieldExpr")
	}
}

func TestFilterPublish650E34(t *testing.T) {
	doc := func(with string) string {
		return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e34-filter
spec:
  triggers:
    - {id: manual, type: manual}
  nodes:
    - {id: seed, type: data.set, name: Seed, with: {value: {items: [{n: 1}, {n: 5}]}}}
    - {id: f, type: data.filter, name: F, with: ` + with + `}
    - {id: k, type: flow.stop, name: K, with: {status: success}}
    - {id: d, type: flow.stop, name: D, with: {status: success}}
  edges:
    - {from: seed.result, to: f.input}
    - {from: f.kept, to: k.input}
    - {from: f.dropped, to: d.input}
`
	}
	res, errs := ParseAndNormalize([]byte(doc(`{expr: {expr: 'item.n > 2'}}`)))
	if len(errs) > 0 {
		t.Fatalf("%v", errs)
	}
	if rep, cerrs := CheckExpressions(res.Document); len(cerrs) > 0 || len(rep.Refs) != 1 || rep.Refs[0].Type != "bool" {
		t.Fatalf("%+v %v", rep, cerrs)
	}
	res, _ = ParseAndNormalize([]byte(doc(`{expr: {expr: '"x"'}}`)))
	if _, cerrs := CheckExpressions(res.Document); len(cerrs) != 1 || cerrs[0].Code != CodeExpressionType {
		t.Fatalf("%v", cerrs)
	}
	if _, errs := ParseAndNormalize([]byte(doc(`{path: n, op: gt, compare: 2}`))); len(errs) > 0 {
		t.Fatalf("%v", errs)
	}
	if _, errs := ParseAndNormalize([]byte(doc(`{expr: {expr: 'true'}, op: gt}`))); len(errs) == 0 {
		t.Fatal("expr combined with op accepted")
	}
	if _, errs := ParseAndNormalize([]byte(doc(`{path: n}`))); !hasCodeAt(errs, CodeMissingField, "with.op") {
		t.Fatalf("%v", errs)
	}
}

func TestSortStableDeterministic650E34(t *testing.T) {
	in := map[string]any{"input": items(
		map[string]any{"id": "a", "k": 2},
		map[string]any{"id": "b", "k": 1},
		map[string]any{"id": "c", "k": 2},
		map[string]any{"id": "d", "k": json.Number("9007199254740993")},
		map[string]any{"id": "e", "k": json.Number("9007199254740992")},
		map[string]any{"id": "f", "k": 1.0},
	)}
	// Gracie check 2: stable (equal keys keep input order) in both
	// directions, and the same input always gives the same order.
	for i := 0; i < 20; i++ {
		asc := EvaluateStep("data.sort", map[string]any{"key": "k"}, in, nil)
		if asc.Fail || !eqIDs(ids(t, asc.Output["result"]), "b", "f", "a", "c", "e", "d") {
			t.Fatalf("asc %+v", asc)
		}
		desc := EvaluateStep("data.sort", map[string]any{"key": "k", "order": "desc"}, in, nil)
		if desc.Fail || !eqIDs(ids(t, desc.Output["result"]), "d", "e", "a", "c", "b", "f") {
			t.Fatalf("desc %+v", desc)
		}
	}
	str := EvaluateStep("data.sort", map[string]any{"key": "n.s", "type": "string"}, map[string]any{"input": items(
		map[string]any{"id": 1, "n": map[string]any{"s": "b"}},
		map[string]any{"id": 2, "n": map[string]any{"s": "a"}},
	)}, nil)
	if str.Fail || !eqIDs(ids(t, str.Output["result"]), 2, 1) {
		t.Fatalf("%+v", str)
	}
}

func TestSortTimestamp650E34(t *testing.T) {
	in := map[string]any{"input": items(
		map[string]any{"id": 1, "at": "2026-10-22T10:00:00-05:00"},
		map[string]any{"id": 2, "at": "2026-10-22T14:30:00Z"},
		map[string]any{"id": 3, "at": "2026-10-22T15:00:00.5Z"},
	)}
	// As strings, "2026-10-22T10..." sorts first; as instants it is last.
	ts := EvaluateStep("data.sort", map[string]any{"key": "at", "type": "timestamp"}, in, nil)
	if ts.Fail || !eqIDs(ids(t, ts.Output["result"]), 2, 1, 3) {
		t.Fatalf("%+v", ts)
	}
	bad := EvaluateStep("data.sort", map[string]any{"key": "at", "type": "timestamp"}, map[string]any{"input": items(
		map[string]any{"at": "2026-10-22T10:00:00Z"}, map[string]any{"at": "yesterday"},
	)}, nil)
	if !bad.Fail || bad.Code != CodeSortMixedTypes || strings.Contains(bad.Message, "yesterday") {
		t.Fatalf("%+v", bad)
	}
}

func TestSortMixedTypesFails650E34(t *testing.T) {
	cases := map[string]struct {
		with map[string]any
		in   map[string]any
		code string
	}{
		"number then string": {map[string]any{"key": "k"}, items(map[string]any{"k": 1}, map[string]any{"k": "1"}), CodeSortMixedTypes},
		"declared number":    {map[string]any{"key": "k", "type": "number"}, items(map[string]any{"k": "1"}), CodeSortMixedTypes},
		"bool key":           {map[string]any{"key": "k"}, items(map[string]any{"k": true}), CodeSortMixedTypes},
		"object key":         {map[string]any{"key": "k"}, items(map[string]any{"k": map[string]any{}}), CodeSortMixedTypes},
		"missing key":        {map[string]any{"key": "k"}, items(map[string]any{"k": 1}, map[string]any{"x": 1}), CodeSortKeyMissing},
		"null key":           {map[string]any{"key": "k"}, items(map[string]any{"k": nil}), CodeSortKeyMissing},
	}
	for name, c := range cases {
		out := EvaluateStep("data.sort", c.with, map[string]any{"input": c.in}, nil)
		if !out.Fail || out.Code != c.code || out.Output != nil {
			t.Fatalf("%s: %+v", name, out)
		}
	}
}

func TestMergeModes650E34(t *testing.T) {
	left := items(map[string]any{"id": 1, "x": "a1"}, map[string]any{"id": 2, "x": "a2"})
	right := items(map[string]any{"id": 1, "y": "b1"}, map[string]any{"id": 3, "y": "b3"})
	in := map[string]any{"left": left, "right": right}

	app := EvaluateStep("data.merge", map[string]any{"mode": "append"}, in, nil)
	if app.Fail || !eqIDs(ids(t, app.Output["result"]), 1, 2, 1, 3) {
		t.Fatalf("%+v", app)
	}
	zip := EvaluateStep("data.merge", map[string]any{"mode": "zip"}, in, nil)
	z := itemList(t, zip.Output["result"])
	if zip.Fail || len(z) != 2 || z[0]["x"] != "a1" || z[0]["y"] != "b1" || !valuesEqual(z[1]["id"], 3) {
		t.Fatalf("zip %+v", zip)
	}
	by := EvaluateStep("data.merge", map[string]any{"mode": "byKey", "key": "id"}, in, nil)
	b := itemList(t, by.Output["result"])
	if by.Fail || len(b) != 3 || b[0]["x"] != "a1" || b[0]["y"] != "b1" || b[1]["x"] != "a2" || b[2]["y"] != "b3" {
		t.Fatalf("byKey %+v", by)
	}
	// Numbers join exactly: 1 and 1.0 join, 2^53 and 2^53+1 do not.
	exact := EvaluateStep("data.merge", map[string]any{"mode": "byKey", "key": "id"}, map[string]any{
		"left":  items(map[string]any{"id": 1.0, "x": 1}, map[string]any{"id": json.Number("9007199254740993"), "x": 2}),
		"right": items(map[string]any{"id": int64(1), "y": 1}, map[string]any{"id": json.Number("9007199254740992"), "y": 2}),
	}, nil)
	if e := itemList(t, exact.Output["result"]); exact.Fail || len(e) != 3 || e[0]["y"] == nil || e[1]["y"] != nil {
		t.Fatalf("exact %+v", exact)
	}
	// A string key never joins a number.
	sn := EvaluateStep("data.merge", map[string]any{"mode": "byKey", "key": "id"}, map[string]any{
		"left": items(map[string]any{"id": "1"}), "right": items(map[string]any{"id": 1}),
	}, nil)
	if sn.Fail || len(itemList(t, sn.Output["result"])) != 2 {
		t.Fatalf("%+v", sn)
	}
}

func TestMergeFailsClosed650E34(t *testing.T) {
	cases := map[string]struct {
		with map[string]any
		in   map[string]any
		code string
	}{
		"zip length": {map[string]any{"mode": "zip"}, map[string]any{"left": items(map[string]any{}), "right": items()}, CodeMergeLengthMismatch},
		"dup key":    {map[string]any{"mode": "byKey", "key": "id"}, map[string]any{"left": items(map[string]any{"id": 1}, map[string]any{"id": 1.0}), "right": items()}, CodeMergeDuplicateKey},
		"no key":     {map[string]any{"mode": "byKey", "key": "id"}, map[string]any{"left": items(), "right": items(map[string]any{"x": 1})}, CodeMergeKeyMissing},
		"bool key":   {map[string]any{"mode": "byKey", "key": "id"}, map[string]any{"left": items(map[string]any{"id": true}), "right": items()}, CodeInvalidType},
		"bad mode":   {map[string]any{"mode": "union"}, map[string]any{"left": items(), "right": items()}, CodeInvalidWith},
		"no right":   {map[string]any{"mode": "append"}, map[string]any{"left": items()}, CodeRequiredInput},
	}
	for name, c := range cases {
		out := EvaluateStep("data.merge", c.with, c.in, nil)
		if !out.Fail || out.Code != c.code {
			t.Fatalf("%s: %+v", name, out)
		}
	}
	// The merged port stays under the 16 KiB cap.
	big := strings.Repeat("x", MaxPortBytes/2-64)
	o := EvaluateStep("data.merge", map[string]any{"mode": "append"}, map[string]any{
		"left": items(map[string]any{"v": big}), "right": items(map[string]any{"v": big}, map[string]any{"v": big}),
	}, nil)
	if !o.Fail || o.Code != CodeOutputTooLarge {
		t.Fatalf("%+v", o)
	}
}

func TestMergePublish650E34(t *testing.T) {
	doc := func(with string) string {
		return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e34-merge
spec:
  triggers:
    - {id: manual, type: manual}
  nodes:
    - {id: a, type: data.set, name: A, with: {value: {items: [{id: 1}]}}}
    - {id: b, type: data.set, name: B, with: {value: {items: [{id: 2}]}}}
    - {id: m, type: data.merge, name: M, join: all, with: ` + with + `}
    - {id: s, type: data.sort, name: S, with: {key: id, order: desc}}
    - {id: done, type: flow.stop, name: Done, with: {status: success}}
  edges:
    - {from: a.result, to: m.left}
    - {from: b.result, to: m.right}
    - {from: m.result, to: s.input}
    - {from: s.result, to: done.input}
`
	}
	for _, ok := range []string{`{mode: append}`, `{mode: zip}`, `{mode: byKey, key: id}`} {
		if _, errs := ParseAndNormalize([]byte(doc(ok))); len(errs) > 0 {
			t.Fatalf("%s: %v", ok, errs)
		}
	}
	for _, bad := range []string{`{mode: byKey}`, `{mode: append, key: id}`, `{mode: union}`, `{}`} {
		if _, errs := ParseAndNormalize([]byte(doc(bad))); len(errs) == 0 {
			t.Fatalf("%s accepted", bad)
		}
	}
	sortBad := strings.Replace(doc(`{mode: append}`), "{key: id, order: desc}", "{key: id, type: date}", 1)
	if _, errs := ParseAndNormalize([]byte(sortBad)); !hasCodeAt(errs, CodeInvalidWith, "with.type") {
		t.Fatalf("%v", errs)
	}
}

// The E3.4 nodes are core in the catalog, and their output keys are
// fixed port names, never an engine key.
func TestE34CatalogCore(t *testing.T) {
	for _, typ := range []string{"flow.switch", "data.filter", "data.sort", "data.merge"} {
		nt, ok := lookupNode(typ)
		if !ok || nt.Phase != PhaseCore || !IsCoreNeutral(typ) || nt.Policy == nil || nt.Bounds == nil || nt.Redaction == nil {
			t.Fatalf("%s: %+v", typ, nt)
		}
	}
}

// An unknown case field is reported at the case index with a fixed
// message; the client-chosen key is never echoed.
func TestSwitchUnknownCaseFieldNotEchoed650E34(t *testing.T) {
	doc := strings.Replace(switchDoc(true), "{name: gold, op: eq, compare: gold}", "{name: gold, op: eq, compare: gold, zzSecretKey: 1}", 1)
	_, errs := ParseAndNormalize([]byte(doc))
	if !hasCodeAt(errs, CodeUnknownField, "with.cases[1]") {
		t.Fatalf("unknown case field accepted: %v", errs)
	}
	for _, e := range errs {
		if strings.Contains(e.Path, "zzSecretKey") || strings.Contains(e.Message, "zzSecretKey") {
			t.Fatalf("client key echoed: %+v", e)
		}
		if e.Code == CodeUnknownField && strings.Contains(e.Path, "cases[1].") {
			t.Fatalf("path is not index-only: %q", e.Path)
		}
	}
}

// data.filter builds its expression once per step, not once per item.
func TestFilterExprCompiledOncePerStep650E34(t *testing.T) {
	n := 0
	prepareFieldExprHook = func() { n++ }
	defer func() { prepareFieldExprHook = nil }()
	var its []map[string]any
	for i := 0; i < 50; i++ {
		its = append(its, map[string]any{"id": i, "n": int64(i)})
	}
	with := map[string]any{"expr": map[string]any{"expr": `item.n >= 25`}}
	out := EvaluateStepRun("data.filter", with, map[string]any{"input": items(its...)}, nil, rc("f"))
	if out.Fail {
		t.Fatalf("%+v", out)
	}
	if n != 1 {
		t.Fatalf("expression prepared %d times for 50 items, want 1", n)
	}
	var kept []any
	b, _ := json.Marshal(out.Output["kept"])
	var kv map[string]any
	_ = json.Unmarshal(b, &kv)
	kept, _ = kv["items"].([]any)
	if len(kept) != 25 {
		t.Fatalf("kept %d, want 25", len(kept))
	}
}
