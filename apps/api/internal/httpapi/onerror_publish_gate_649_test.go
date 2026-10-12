package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// #649 S1: drafts with onError: errorOutput save and validate; only publish
// refuses with on-error-not-yet-supported until S2 enables the engine path.
func onErrorPersistYAML(mode, from string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: on-error-gate-` + strings.ToLower(mode) + `
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: constants
      type: data.set
      name: Constants
      onError: ` + mode + `
      with:
        value:
          env: staging
    - id: mapped
      type: data.map
      name: Map
      with:
        mapping:
          environment: env
  edges:
    - from: constants.` + from + `
      to: mapped.input
`
}

func TestOnErrorDraftSavesButPublishGated649(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	src := onErrorPersistYAML("errorOutput", "error")

	body, _ := json.Marshal(map[string]any{"definitionYaml": src})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, ws))
	if rec.Code != http.StatusOK {
		t.Fatalf("validate: %d %s", rec.Code, rec.Body.String())
	}
	created := createWorkflow(t, h, admin, tenant, ws, src)

	pub, _ := json.Marshal(map[string]any{"revision": created.Draft.Revision})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/publish", pub, admin, tenant, ws))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"on-error-not-yet-supported"`) {
		t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}

	stop := createWorkflow(t, h, admin, tenant, ws, onErrorPersistYAML("stop", "result"))
	publishWorkflow(t, h, admin, tenant, ws, stop.Workflow.ID, stop.Draft.Revision, "stop publishes")
}
