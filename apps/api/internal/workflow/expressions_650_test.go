package workflow

import (
	"strings"
	"testing"
)

// #650 E3.2: publish-time FFX check over a parsed document.

func ffxDoc(with string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ffx
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
          env: staging
    - id: check
      type: test.ffx
      name: Check
      with:
` + with + `
  edges:
    - from: constants.result
      to: check.config
`
}

func checkDoc(t *testing.T, with string) (ExpressionReport, ErrorList) {
	t.Helper()
	EnableExpressionTestNode()
	res, errs := ParseAndNormalize([]byte(ffxDoc(with)))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	return CheckExpressions(res.Document)
}

func TestCheckExpressionsRecordsRefs650(t *testing.T) {
	rep, errs := checkDoc(t, `        when: {expr: 'input.config.env == "staging" && item.total > 1000'}
        handle: {expr: "vars.deployKey"}`)
	if len(errs) > 0 {
		t.Fatalf("errs: %v", errs)
	}
	if len(rep.Refs) != 2 {
		t.Fatalf("refs = %+v", rep.Refs)
	}
	h, w := rep.Refs[0], rep.Refs[1]
	if h.Field != "handle" || h.Type != "flowforge.SecretRef" || strings.Join(h.Vars, ",") != "deployKey" {
		t.Fatalf("handle = %+v", h)
	}
	if w.Field != "when" || w.Type != "bool" || len(w.Inputs) != 1 || w.Inputs[0] != (InputRef{Port: "config", From: "constants.result"}) || !w.Item {
		t.Fatalf("when = %+v", w)
	}
	types := rep.Types()
	if types[1].Path != "spec.nodes[check].with.when.expr" || types[1].Type != "bool" {
		t.Fatalf("types = %+v", types)
	}
}

// Publish-time errors name the nodeId and carry no line or column.
func TestCheckExpressionsErrorsNameNode650(t *testing.T) {
	for _, c := range []struct{ with, code string }{
		{`        when: {expr: "1 +"}`, CodeExpressionParse},
		{`        when: {expr: '"yes"'}`, CodeExpressionType},
		{`        when: {expr: "input.orders.size() > 0"}`, CodeExpressionRefNotAncestor},
		{`        when: {expr: "input.nope == 1"}`, CodeExpressionRefUnknown},
		{`        when: {expr: 'vars.k == "x"'}`, CodeExpressionSecretUse},
		{`        value: {expr: "vars.k"}`, CodeExpressionSecretUse},
		{`        mode: once
        when: {expr: "items.all(x, items.exists(y, x.id == y.id))"}`, CodeExpressionTooComplex},
	} {
		_, errs := checkDoc(t, c.with)
		if len(errs) != 1 {
			t.Fatalf("%s: errs = %v", c.with, errs)
		}
		e := errs[0]
		if e.Code != c.code || e.NodeID != "check" || e.Line != 0 || e.Column != 0 || !strings.HasPrefix(e.Path, "spec.nodes[check].with.") {
			t.Fatalf("%s: %+v", c.with, e)
		}
	}
}

func TestDocsWithoutExpressionsUnchanged650(t *testing.T) {
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: plain
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
          expr: "not an expression; data.set has no expr field"
  edges: []
`
	res, errs := ParseAndNormalize([]byte(src))
	if len(errs) > 0 {
		t.Fatalf("parse: %v", errs)
	}
	rep, cerrs := CheckExpressions(res.Document)
	if len(cerrs) > 0 || len(rep.Refs) != 0 {
		t.Fatalf("refs=%v errs=%v", rep.Refs, cerrs)
	}
}

func TestCatalogRevision650(t *testing.T) {
	c := CoreCatalog()
	if c.CatalogRevision != CatalogRevision || CatalogRevision < 1 || c.APIVersion != APIVersionV1 {
		t.Fatalf("catalog revision %d api %s", c.CatalogRevision, c.APIVersion)
	}
	// E3.3: exactly data.map.expr (object) and flow.condition.expr
	// (boolean) are production expr fields; neither accepts a secret ref.
	want := map[string]string{"data.map.expr": string(PortObject), "flow.condition.expr": string(PortBoolean)}
	got := map[string]string{}
	for _, n := range c.Nodes {
		for _, f := range n.AllowedWith {
			if f.Kind == WithKindExpr {
				if f.AcceptsSecretRef {
					t.Fatalf("%s.%s accepts a secret ref", n.Type, f.Name)
				}
				got[n.Type+"."+f.Name] = f.ExprType
			}
		}
	}
	if len(got) != len(want) {
		t.Fatalf("expr fields = %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("expr fields = %v", got)
		}
	}
}
