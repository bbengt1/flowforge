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
	if !cat.Rules.TriggersAreWorkflowLevel || !cat.Rules.GraphNodesExcludeTriggers {
		t.Fatalf("catalog rules = %+v", cat.Rules)
	}
	found := false
	for _, n := range cat.Nodes {
		if n.Type == "flow.condition" {
			found = true
			if n.Policy == nil || n.Bounds == nil || n.Redaction == nil || len(n.AllowedWith) == 0 {
				t.Fatalf("flow.condition contract incomplete: %+v", n)
			}
			if n.Inputs[0].Classification == "" || n.Inputs[0].MaxBytes == 0 {
				t.Fatalf("flow.condition ports: %+v", n.Inputs)
			}
		}
		if n.Type == "workflow.call" && n.Phase != workflow.PhaseNext {
			t.Fatalf("workflow.call should remain next-phase: %+v", n)
		}
	}
	if !found {
		t.Fatal("catalog missing flow.condition")
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

	t.Run("core neutral contracts", func(t *testing.T) {
		src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: core-neutral-http
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
    - id: gate
      type: flow.condition
      name: Gate
      with:
        op: eq
        compare: staging
        path: env
    - id: pause
      type: flow.delay
      name: Pause
      with:
        duration: PT1M
    - id: done
      type: flow.stop
      name: Done
      with:
        status: success
    - id: failed
      type: flow.fail
      name: Failed
      with:
        code: env-mismatch
  edges:
    - from: constants.result
      to: gate.value
    - from: gate.true
      to: pause.input
    - from: pause.result
      to: done.input
    - from: gate.false
      to: failed.input
`
		body, _ := json.Marshal(map[string]string{"definitionYaml": src})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/normalize", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("normalize core: %d %s", rec.Code, rec.Body.String())
		}
		var payload normalizeResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Summary.Name != "core-neutral-http" || len(payload.Summary.Nodes) != 5 {
			t.Fatalf("summary = %+v", payload.Summary)
		}

		bad, _ := json.Marshal(map[string]string{"definitionYaml": strings.Replace(src, "PT1M", "P30D", 1)})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", bad, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
		if !problemHasCode(p, workflow.CodeDurationLimit) {
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
