package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.3 QA M2: the YAML template check skips FFX expression source
// only (with.expr on data.map and flow.condition). A nested map literal or
// a "}}" / "{{" inside a string literal saves and publishes; a template in
// any other field is still refused. Through the save and publish API.

func exprTemplateDoc(name, mapExpr, condExpr string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: ` + name + `
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

func TestExprFieldsSkipTemplateCheckThroughSaveAPI650(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	accepted := []struct{ name, mapExpr, condExpr string }{
		{"FFX Nested Map", `{"a": {"b": 1}}`, `item.a.b == 1`},
		{"FFX Braces In Strings", `{"s": "x }} y {{ z }}", "t": "{% %} ${v} <%"}`, `item.s != "}}" && item.t != "{{"`},
		{"FFX Nested Lists", `{"a": {"b": {"c": [1, 2]}}}`, `{"k": {"v": true}}.k.v`},
	}
	for _, c := range accepted {
		created := createWorkflow(t, h, admin, tenant, ws, exprTemplateDoc(c.name, c.mapExpr, c.condExpr))
		// Save the same draft again through PUT /draft.
		rec := putDraftRaw(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, exprTemplateDoc(c.name, c.mapExpr, c.condExpr))
		if rec.Code != http.StatusOK {
			t.Fatalf("%s: save draft = %d %s", c.name, rec.Code, rec.Body.String())
		}
		var saved workflowDetailResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, saved.Draft.Revision, "")
		if pub.Version.ID == "" {
			t.Fatalf("%s: publish returned no version", c.name)
		}
	}

	refused := []struct{ name, src string }{
		{"mapping template", strings.Replace(exprTemplateDoc("Tpl Mapping", `{"a": 1}`, `true`),
			"        expr: {expr: '{\"a\": 1}'}", "        mapping:\n          environment: '{{ total }}'", 1)},
		{"mapping close braces", strings.Replace(exprTemplateDoc("Tpl Mapping Close", `{"a": 1}`, `true`),
			"        expr: {expr: '{\"a\": 1}'}", "        mapping:\n          environment: 'total }}'", 1)},
		{"condition path template", strings.Replace(exprTemplateDoc("Tpl Path", `{"a": 1}`, `true`),
			"        expr: {expr: 'true'}", "        op: eq\n        compare: x\n        path: '{{ a }}'", 1)},
		{"condition path close braces", strings.Replace(exprTemplateDoc("Tpl Path Close", `{"a": 1}`, `true`),
			"        expr: {expr: 'true'}", "        op: eq\n        compare: x\n        path: 'a }}'", 1)},
		// data.set declares no expression field: an expr-shaped value
		// there is ordinary data and keeps the check.
		{"non-expression node", strings.Replace(exprTemplateDoc("Tpl Set", `{"a": 1}`, `true`),
			"          total: 5", "          total: 5\n          expr: '{\"a\": {\"b\": 1}}'", 1)},
		// An expr field that is not exactly {expr: <string>} is not exempt.
		{"expr with extra key", strings.Replace(exprTemplateDoc("Tpl Extra", `{"a": 1}`, `true`),
			"        expr: {expr: '{\"a\": 1}'}", "        expr: {expr: '{\"a\": 1}', note: '{{ x }}'}", 1)},
	}
	for _, c := range refused {
		body, _ := json.Marshal(map[string]string{"definitionYaml": c.src})
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows", body, admin, tenant, ws))
		if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), workflow.CodeTemplateForbidden) {
			t.Fatalf("%s: create = %d %s", c.name, rec.Code, rec.Body.String())
		}
	}

	// PUT /draft refuses a template in an ordinary field too.
	created := createWorkflow(t, h, admin, tenant, ws, exprTemplateDoc("Tpl Put", `{"a": 1}`, `true`))
	rec := putDraftRaw(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, refused[0].src)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), workflow.CodeTemplateForbidden) {
		t.Fatalf("put draft = %d %s", rec.Code, rec.Body.String())
	}
}
