package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

const validWorkflowYAML = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: kubernetes.apply
      name: Restart API
      with:
        clusterTargetId: 11111111-1111-4111-8111-111111111111
        namespace: cp-ops-nprd
        dryRun: server
        manifests: |
          apiVersion: apps/v1
          kind: Deployment
          metadata:
            name: api
  edges: []
`

func TestWorkflowCatalogRequiresView(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/workflows/catalog", nil))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")

	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-viewer","role_keys":["viewer"]}`)
	rec = httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflows/catalog", nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer catalog: %d %s", rec.Code, rec.Body.String())
	}
	var cat workflow.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatal(err)
	}
	if cat.APIVersion != workflow.APIVersionV1 || len(cat.Nodes) == 0 {
		t.Fatalf("catalog = %+v", cat)
	}
}

func TestWorkflowValidateAndNormalize(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	t.Run("json envelope normalize", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"definitionYaml": validWorkflowYAML})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/normalize", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("normalize: %d %s", rec.Code, rec.Body.String())
		}
		var payload normalizeResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(payload.Digest, "sha256:") || payload.DefinitionYAML == "" {
			t.Fatalf("payload = %+v", payload)
		}
		if payload.Summary.Name != "restart-api-rollout" {
			t.Fatalf("summary name = %q", payload.Summary.Name)
		}
	})

	t.Run("raw yaml validate", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodPost, "/api/v1/workflows/validate", strings.NewReader(validWorkflowYAML), admin, tenant, ws)
		req.Header.Set("Content-Type", "application/yaml")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("validate: %d %s", rec.Code, rec.Body.String())
		}
		var payload validateResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if !payload.Valid || len(payload.Summary.Nodes) != 1 {
			t.Fatalf("payload = %+v", payload)
		}
	})

	t.Run("malformed yaml", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"definitionYaml": "apiVersion: [broken"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
		if len(p.Errors) == 0 {
			t.Fatal("expected field errors")
		}
	})

	t.Run("cycle", func(t *testing.T) {
		src := `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: cyclic
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: left
      type: data.map
      name: Left
      with:
        mapping: {a: b}
    - id: right
      type: data.map
      name: Right
      with:
        mapping: {a: b}
  edges:
    - from: left.result
      to: right.input
    - from: right.result
      to: left.input
`
		body, _ := json.Marshal(map[string]string{"definitionYaml": src})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/normalize", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
		if !problemHasCode(p, workflow.CodeCycle) {
			t.Fatalf("errors = %+v", p.Errors)
		}
	})
}

func TestWorkflowEditDeniedForViewer(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-editor-denied","role_keys":["viewer"]}`)
	if contains(viewer.Permissions, authz.PermWorkflowEdit) {
		t.Fatal("viewer should not have workflow.edit")
	}
	body, _ := json.Marshal(map[string]string{"definitionYaml": validWorkflowYAML})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
}

func TestWorkflowMethodNotAllowed(t *testing.T) {
	h := NewWithStore(nil, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/workflows/validate", nil))
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "")
}

func workspaceJSON(method, path string, body []byte, user identity.User, tenant identity.Tenant, ws identity.Workspace) *http.Request {
	req := workspaceRequest(method, path, strings.NewReader(string(body)), user, tenant, ws)
	req.Header.Set("Content-Type", "application/json")
	return req
}

func problemHasCode(p Problem, code string) bool {
	for _, e := range p.Errors {
		if e.Code == code {
			return true
		}
	}
	return false
}
