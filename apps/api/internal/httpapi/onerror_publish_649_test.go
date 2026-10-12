package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// onError: errorOutput and continue save, validate and publish.
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

func TestOnErrorDraftSavesAndPublishes649(t *testing.T) {
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

	publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "errorOutput publishes")
	cont := createWorkflow(t, h, admin, tenant, ws, onErrorPersistYAML("continue", "result"))
	publishWorkflow(t, h, admin, tenant, ws, cont.Workflow.ID, cont.Draft.Revision, "continue publishes")

	stop := createWorkflow(t, h, admin, tenant, ws, onErrorPersistYAML("stop", "result"))
	publishWorkflow(t, h, admin, tenant, ws, stop.Workflow.ID, stop.Draft.Revision, "stop publishes")
}
