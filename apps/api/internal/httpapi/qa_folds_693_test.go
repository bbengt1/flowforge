package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A schedule catchUp that is valid JSON but not an integer gets a typed
// field error naming catchUp, never "not valid JSON", and never echoes
// the value.
func TestScheduleCreateCatchUpTypedError(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, scheduleYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "catchup")
	for _, lit := range []string{"1.0", "1e2", "1.5", "123456789012345678901234567890"} {
		body := `{"workflowId":"` + created.Workflow.ID + `","workflowVersionId":"` + pub.Version.ID + `","timezone":"UTC","interval":"PT15M","catchUp":` + lit + `}`
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/schedules", []byte(body), admin, tenant, ws))
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s: %d %s", lit, rec.Code, rec.Body.String())
		}
		var p struct {
			Detail string `json:"detail"`
			Errors []struct {
				Path, Code, Message string
			} `json:"errors"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		if len(p.Errors) != 1 || p.Errors[0].Path != "catchUp" || p.Errors[0].Code != "invalid-type" || p.Errors[0].Message != "catchUp must be an integer." {
			t.Fatalf("%s: problem = %s", lit, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), lit) || strings.Contains(p.Detail, "not valid JSON") {
			t.Fatalf("%s: problem echoes the value or says invalid JSON: %s", lit, rec.Body.String())
		}
	}
}

const bigYAMLIntWorkflow = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: big-yaml-int
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
          big: 99999999999999999999
          neg: -99999999999999999999
          max: 9223372036854775807
          small: 42
  edges: []
`

// An integer literal beyond int64 in workflow YAML keeps its digits
// through save, publish and export; int64 values stay exact as before.
func TestWorkflowYAMLBigIntegerExactThroughSaveAndPublish(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, bigYAMLIntWorkflow)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "big")
	exported := exportVersionYAML(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	for label, doc := range map[string]string{"draft": created.Draft.DefinitionYAML, "export": exported} {
		for _, want := range []string{"big: 99999999999999999999", "neg: -99999999999999999999", "max: 9223372036854775807", "small: 42"} {
			if !strings.Contains(doc, want) {
				t.Fatalf("%s lost %q:\n%s", label, want, doc)
			}
		}
		if strings.Contains(doc, "1e+20") || strings.Contains(doc, "100000000000000000000") {
			t.Fatalf("%s rounded the literal:\n%s", label, doc)
		}
	}
}
