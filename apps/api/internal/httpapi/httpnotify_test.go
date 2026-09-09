package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/httpnotify"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

func TestHTTPNotificationCatalogAndPins(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)

	t.Run("catalogs document the integration gate", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/ops-config/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("ops catalog: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), `"httpNotificationEngine"`) || !strings.Contains(rec.Body.String(), `"http.request"`) {
			t.Fatalf("ops catalog missing http engine: %s", rec.Body.String())
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/http/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("http catalog: %d %s", rec.Code, rec.Body.String())
		}
		var cat httpnotify.EngineCatalog
		if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
			t.Fatal(err)
		}
		if !cat.Gate.Enabled || len(cat.Nodes) != 3 || !cat.Isolation.SSRFDenied {
			t.Fatalf("http catalog = %+v", cat)
		}
		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/workflows/catalog", nil, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"integrationGate"`) {
			t.Fatalf("workflow catalog: %d %s", rec.Code, rec.Body.String())
		}
	})

	httpConn := publishTypedConnection(t, h, admin, tenant, wsA, "status-http", "http", []string{"status.example.com"})
	smtpConn := publishTypedConnection(t, h, admin, tenant, wsA, "ops-smtp", "smtp", []string{"mail.example.com"})

	t.Run("publish pins http connection and rejects wrong type", func(t *testing.T) {
		wf := createWorkflow(t, h, admin, tenant, wsA, httpWorkflowYAML("http-status", httpConn.Resource.ID))
		pub := publishWorkflow(t, h, admin, tenant, wsA, wf.Workflow.ID, wf.Draft.Revision, "pin http")
		if len(pub.Pins) != 1 || pub.Pins[0].ResourceID != httpConn.Resource.ID {
			t.Fatalf("pins = %+v", pub.Pins)
		}

		bad := createWorkflow(t, h, admin, tenant, wsA, httpWorkflowYAML("http-wrong-type", smtpConn.Resource.ID))
		body, _ := json.Marshal(map[string]any{"revision": bad.Draft.Revision, "note": "wrong type"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+bad.Workflow.ID+"/publish", body, admin, tenant, wsA)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	})

	t.Run("cross-workspace connection cannot be pinned", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_id":"`+tenant.ID+`","workbench_key":"http-b","name":"B"}`, admin)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
		}
		var wsB identity.Workspace
		if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
			t.Fatal(err)
		}
		wf := createWorkflow(t, h, admin, tenant, wsB, httpWorkflowYAML("http-cross", httpConn.Resource.ID))
		body, _ := json.Marshal(map[string]any{"revision": wf.Draft.Revision, "note": "cross"})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+wf.Workflow.ID+"/publish", body, admin, tenant, wsB)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")
	})
}

func publishTypedConnection(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, name, typ string, hosts []string) opsPublishResponse {
	t.Helper()
	created := createOpsResource(t, h, user, tenant, ws, "connections", name, map[string]any{
		"type": typ,
		"endpointPolicy": map[string]any{
			"hosts": hosts, "methods": []string{"GET", "POST"}, "pathPrefixes": []string{"/v1/", "/"},
			"allowedAddresses": []string{"127.0.0.1"},
		},
	})
	return publishOps(t, h, user, tenant, ws, "connections", created.Resource.ID, created.Draft.Revision, "v1")
}

func httpWorkflowYAML(name, connectionID string) string {
	return fmt.Sprintf(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: %s
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: call
      type: http.request
      name: Check status
      with:
        connectionId: %s
        method: GET
        path: /v1/status
  edges: []
`, name, connectionID)
}
