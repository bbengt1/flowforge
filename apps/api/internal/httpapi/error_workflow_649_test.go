package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
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
	base := "/api/v1/workspace/error-workflow"

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

// TestWorkspaceErrorWorkflowStepUp649: a workspace admin on a local
// password session without a fresh MFA step-up may read the setting but
// PUT and DELETE are refused with mfa-required and change nothing.
func TestWorkspaceErrorWorkflowStepUp649(t *testing.T) {
	store := identity.NewMemory()
	workflows := wfstore.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     store,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: workflows,
	}))
	owner := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, owner))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, owner))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	ws, tenant := currentWorkspace(t, h, owner)
	seedLocalLogin(t, store, "https://idp.example", "ew-local-admin", "Local Admin", "correct-horse")
	putMember(t, h, owner, tenant, ws, `{"issuer":"https://idp.example","external_subject":"ew-local-admin","display_name":"Local Admin","role_keys":["admin"]}`)
	token, csrf := loginLocal(t, h, "ew-local-admin", "correct-horse")

	const base = "/api/v1/workspace/error-workflow"
	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionWorkspaceRequest(http.MethodGet, base, token, csrf, tenant, ws))
	if get.Code != http.StatusOK {
		t.Fatalf("get without step-up = %d %s", get.Code, get.Body.String())
	}
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		req := sessionWorkspaceRequest(method, base, token, csrf, tenant, ws)
		if method == http.MethodPut {
			req.Body = io.NopCloser(strings.NewReader(`{"workflowId":"6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b"}`))
			req.Header.Set("Content-Type", "application/json")
		}
		denied := httptest.NewRecorder()
		h.ServeHTTP(denied, req)
		if denied.Code != http.StatusForbidden || !strings.Contains(denied.Body.String(), CodeMFARequired) {
			t.Fatalf("%s without step-up = %d %s", method, denied.Code, denied.Body.String())
		}
	}
}
