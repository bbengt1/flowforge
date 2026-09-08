package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestIsolationAPIRejectsCrossWorkspaceSurfaces(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)

	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"other-iso","name":"Other"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace B: %d %s", rec.Code, rec.Body.String())
	}
	var wsB identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
		t.Fatal(err)
	}

	cred := createScopedRecord(t, h, admin, tenant, wsA, `{"kind":"credential","name":"k8s"}`)
	art := createScopedRecord(t, h, admin, tenant, wsA, `{"kind":"artifact","name":"log"}`)
	ch := createScopedRecord(t, h, admin, tenant, wsA, `{"kind":"realtime","name":"runs"}`)
	createScopedRecord(t, h, admin, tenant, wsA, `{"kind":"job","name":"run-1"}`)

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workspace/records/"+cred.ID, nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workspace/records?kind=credential", nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("list B: %d %s", rec.Code, rec.Body.String())
	}
	var listed listResponse[isolation.Record]
	if err := json.Unmarshal(rec.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Items) != 0 {
		t.Fatalf("list leaked %d credentials", len(listed.Items))
	}

	rec = httptest.NewRecorder()
	body := `{"kind":"job"}`
	req = workspaceRequest(http.MethodPost, "/api/v1/workspace/records/"+cred.ID+"/links", strings.NewReader(body), admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodPost, "/api/v1/workspace/credentials/"+cred.ID+"/use", nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workspace/artifacts/"+art.ID, nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodPost, "/api/v1/workspace/realtime/channels/"+ch.ID+"/subscribe", nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodPut, "/api/v1/workspace/cache/job-1", strings.NewReader(`{"value":"a"}`), admin, tenant, wsA)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("cache set A: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workspace/cache/job-1", nil, admin, tenant, wsB)
	req.Header.Set(headerWorkbenchKey, wsB.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
}

func TestIsolationAPIRejectsHostSuppliedWorkspaceOnWrite(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	rec := httptest.NewRecorder()
	body := `{"kind":"credential","name":"x","workspace_id":"33333333-3333-3333-3333-333333333333"}`
	req := workspaceRequest(http.MethodPost, "/api/v1/workspace/records", strings.NewReader(body), admin, tenant, ws)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}

func TestIsolationAPIDeniesCredentialUseWithoutPermission(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	cred := createScopedRecord(t, h, admin, tenant, ws, `{"kind":"credential","name":"k8s"}`)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"iso-viewer","role_keys":["viewer"]}`)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodPost, "/api/v1/workspace/credentials/"+cred.ID+"/use", nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func createScopedRecord(t *testing.T, h http.Handler, actor identity.User, tenant identity.Tenant, ws identity.Workspace, body string) isolation.Record {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodPost, "/api/v1/workspace/records", strings.NewReader(body), actor, tenant, ws)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create record: %d %s", rec.Code, rec.Body.String())
	}
	var out isolation.Record
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}
