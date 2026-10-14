package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

const errorWorkflowHTTPYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: On Error
spec:
  triggers:
    - id: on-error
      type: error
  nodes:
    - id: note
      type: data.set
      name: Note
      with:
        value:
          seen: true
`

const manualHTTPYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: Plain Manual
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: note
      type: data.set
      name: Note
      with:
        value:
          seen: true
`

// TestWorkspaceErrorWorkflowRoutes649 pins the #649 S3 admin door and
// the manual-start refusal for an error workflow.
func TestWorkspaceErrorWorkflowRoutes649(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"ew-viewer","display_name":"Viewer","role_keys":["viewer"]}`).User
	editor := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"ew-editor","display_name":"Editor","role_keys":["editor"]}`).User

	do := func(user identity.User, method, path, body string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		if body == "" {
			h.ServeHTTP(rec, workspaceRequest(method, path, nil, user, tenant, ws))
		} else {
			h.ServeHTTP(rec, workspaceJSON(method, path, []byte(body), user, tenant, ws))
		}
		return rec
	}
	base := "/api/v1/workspaces/" + ws.ID + "/error-workflow"

	target := createWorkflow(t, h, admin, tenant, ws, errorWorkflowHTTPYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, target.Workflow.ID, target.Draft.Revision, "v1")
	manual := createWorkflow(t, h, admin, tenant, ws, manualHTTPYAML)
	publishWorkflow(t, h, admin, tenant, ws, manual.Workflow.ID, manual.Draft.Revision, "v1")
	put := `{"workflowId":"` + target.Workflow.ID + `"}`

	for _, u := range []identity.User{viewer, editor} {
		for _, c := range [][3]string{{http.MethodGet, base, ""}, {http.MethodPut, base, put}, {http.MethodDelete, base, ""}} {
			assertProblem(t, do(u, c[0], c[1], c[2]), http.StatusForbidden, CodeForbidden, "")
		}
	}
	other := "/api/v1/workspaces/6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b/error-workflow"
	for _, p := range []string{other, "/api/v1/workspaces/not-a-uuid/error-workflow"} {
		assertProblem(t, do(admin, http.MethodPut, p, put), http.StatusNotFound, CodeNotFound, "")
		assertProblem(t, do(admin, http.MethodGet, p, ""), http.StatusNotFound, CodeNotFound, "")
	}

	if rec := do(admin, http.MethodGet, base, ""); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"errorWorkflow":null`) {
		t.Fatalf("get unset = %d %s", rec.Code, rec.Body.String())
	}
	assertProblem(t, do(admin, http.MethodPut, base, `{"workflowId":"`+manual.Workflow.ID+`"}`), http.StatusBadRequest, CodeInvalidRequest, "")
	assertProblem(t, do(admin, http.MethodPut, base, `{"workflowId":"`+target.Workflow.ID+`","workspaceId":"`+ws.ID+`"}`), http.StatusBadRequest, CodeInvalidRequest, "")

	rec := do(admin, http.MethodPut, base, put)
	if rec.Code != http.StatusOK {
		t.Fatalf("put = %d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		ErrorWorkflow struct {
			WorkflowID   string `json:"workflowId"`
			WorkflowName string `json:"workflowName"`
		} `json:"errorWorkflow"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil || got.ErrorWorkflow.WorkflowID != target.Workflow.ID || got.ErrorWorkflow.WorkflowName != "On Error" {
		t.Fatalf("put body = %s", rec.Body.String())
	}

	// Manual/API start of an error workflow is refused.
	start := do(admin, http.MethodPost, "/api/v1/workflows/"+target.Workflow.ID+"/executions", `{"workflowVersionId":"`+pub.Version.ID+`","idempotencyKey":"ew-1"}`)
	assertProblem(t, start, http.StatusBadRequest, CodeInvalidRequest, "")

	if rec := do(admin, http.MethodDelete, base, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("delete = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(admin, http.MethodDelete, base, ""); rec.Code != http.StatusNoContent {
		t.Fatalf("second delete = %d %s", rec.Code, rec.Body.String())
	}
}
