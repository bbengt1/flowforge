package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestExecutionIdempotencyRedactionAndQueryRoutes(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "e5")

	body, _ := json.Marshal(map[string]any{
		"workflowVersionId": pub.Version.ID,
		"idempotencyKey":    "manual-run-1",
		"input":             map[string]any{"env": "prod", "token": "super-secret-token"},
	})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("start: %d %s", rec.Code, rec.Body.String())
	}
	var first executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Replayed || first.Status != wfstore.ExecutionQueued {
		t.Fatalf("first = %+v", first.Execution)
	}
	if first.Input["token"] != "[redacted]" || first.Input["env"] != "prod" {
		t.Fatalf("input = %#v", first.Input)
	}
	if len(first.Steps) == 0 || len(first.Jobs) == 0 {
		t.Fatalf("expected persisted steps/jobs: %+v %+v", first.Steps, first.Jobs)
	}
	if strings.Contains(rec.Body.String(), "super-secret-token") {
		t.Fatal("plaintext secret persisted or echoed")
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("replay: %d %s", rec.Code, rec.Body.String())
	}
	var replay executionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &replay); err != nil {
		t.Fatal(err)
	}
	if !replay.Replayed || replay.ID != first.ID {
		t.Fatalf("replay = %+v", replay.Execution)
	}

	conflict, _ := json.Marshal(map[string]any{
		"workflowVersionId": pub.Version.ID,
		"idempotencyKey":    "manual-run-1",
		"input":             map[string]any{"env": "staging"},
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", conflict, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/executions", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("workflow list: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[wfstore.Execution]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 1 {
		t.Fatalf("duplicate work listed: %+v", listed.Items)
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions?status=queued", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("workspace list: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+first.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+first.ID+"/steps", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("steps: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/executions/"+first.ID+"/jobs", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("jobs: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/audit-events?resourceType=execution&resourceId="+first.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("audit: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "super-secret-token") {
		t.Fatal("audit leaked secret")
	}
}

const coreNeutralExecutionYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: e5-persist
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
  edges: []
`

func TestExecutionCrossWorkspaceIsNotFound(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "iso")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)

	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodPost, "/api/v1/workspaces", strings.NewReader(`{"tenant_slug":"acme","workbench_key":"other","name":"Other"}`))
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("other workspace: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/executions/"+exec.ID, nil)
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "other")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
}
