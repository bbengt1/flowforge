package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/policy"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func withLayout(src string) string {
	if strings.Contains(src, "\n  ui:") {
		return src
	}
	return strings.Replace(src, "metadata:\n  name: restart-api-rollout\n", `metadata:
  name: restart-api-rollout
  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 120, y: 80 }
`, 1)
}

func TestValidateNormalizePersistLayoutRoundTrip(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	cred := createKubernetesCredential(t, h, admin, tenant, ws, "Layout cluster")
	target := createPublishedClusterTarget(t, h, admin, tenant, ws, cred.ID, "layout-cluster")
	plain := workflowYAMLWithTarget(target.Resource.ID)
	laid := withLayout(plain)

	t.Run("validate and normalize persist-and-return", func(t *testing.T) {
		body, _ := json.Marshal(map[string]string{"definitionYaml": laid})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("validate: %d %s", rec.Code, rec.Body.String())
		}
		var validated validateResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &validated); err != nil {
			t.Fatal(err)
		}
		if !validated.Valid || validated.Summary.UI == nil || validated.Summary.UI.Layout == nil {
			t.Fatalf("validate summary = %+v", validated.Summary)
		}
		if validated.Summary.UI.Layout.Nodes["restart"].X != 120 || len(validated.Summary.Nodes) != 1 {
			t.Fatalf("validate invented or dropped graph: %+v", validated.Summary)
		}

		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/workflows/normalize", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("normalize: %d %s", rec.Code, rec.Body.String())
		}
		var normalized normalizeResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &normalized); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(normalized.DefinitionYAML, "layout:") || !strings.Contains(normalized.DefinitionYAML, "x: 120") {
			t.Fatalf("normalize dropped layout:\n%s", normalized.DefinitionYAML)
		}
		if normalized.Summary.UI == nil || normalized.Summary.UI.Layout.Nodes["restart"].Y != 80 {
			t.Fatalf("normalize summary = %+v", normalized.Summary)
		}
	})

	created := createWorkflow(t, h, admin, tenant, ws, laid)
	if created.Draft.Summary.UI == nil || created.Draft.Summary.UI.Layout == nil {
		t.Fatalf("create draft missing layout: %+v", created.Draft.Summary)
	}
	if !strings.Contains(created.Draft.DefinitionYAML, "layout:") {
		t.Fatalf("create draft YAML missing layout:\n%s", created.Draft.DefinitionYAML)
	}

	t.Run("draft save/load round-trips layout", func(t *testing.T) {
		moved := strings.Replace(created.Draft.DefinitionYAML, "x: 120", "x: 240", 1)
		body, _ := json.Marshal(map[string]any{"revision": created.Draft.Revision, "definitionYaml": moved})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
		}
		var saved workflowDetailResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		if saved.Draft.Summary.UI.Layout.Nodes["restart"].X != 240 {
			t.Fatalf("saved layout = %+v", saved.Draft.Summary.UI)
		}

		rec = httptest.NewRecorder()
		req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/draft", nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("reload: %d %s", rec.Code, rec.Body.String())
		}
		var loaded wfstore.Draft
		if err := json.Unmarshal(rec.Body.Bytes(), &loaded); err != nil {
			t.Fatal(err)
		}
		if loaded.Summary.UI.Layout.Nodes["restart"].X != 240 {
			t.Fatalf("reloaded layout = %+v", loaded.Summary.UI)
		}
		if !strings.Contains(loaded.DefinitionYAML, "x: 240") {
			t.Fatalf("reloaded YAML missing layout:\n%s", loaded.DefinitionYAML)
		}
		created = workflowDetailResponse{Workflow: created.Workflow, Draft: loaded}
	})

	t.Run("drafts with layout still never run", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"source": "draft"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
		if !strings.Contains(rec.Body.String(), "Drafts cannot be executed") {
			t.Fatalf("detail = %s", rec.Body.String())
		}
	})

	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "layout version")
	if !strings.Contains(pub.Version.DefinitionYAML, "layout:") {
		t.Fatalf("published version dropped layout:\n%s", pub.Version.DefinitionYAML)
	}

	t.Run("policy evaluate identical with and without layout", func(t *testing.T) {
		plainNamed := strings.Replace(plain, "name: restart-api-rollout", "name: restart-api-plain", 1)
		plainWF := createWorkflow(t, h, admin, tenant, ws, plainNamed)
		plainPub := publishWorkflow(t, h, admin, tenant, ws, plainWF.Workflow.ID, plainWF.Draft.Revision, "plain")

		body, _ := json.Marshal(map[string]string{"workflowId": created.Workflow.ID, "workflowVersionId": pub.Version.ID})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/policy/evaluate", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("evaluate with layout: %d %s", rec.Code, rec.Body.String())
		}
		var withEval evaluateResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &withEval); err != nil {
			t.Fatal(err)
		}

		body, _ = json.Marshal(map[string]string{"workflowId": plainWF.Workflow.ID, "workflowVersionId": plainPub.Version.ID})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPost, "/api/v1/policy/evaluate", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("evaluate without layout: %d %s", rec.Code, rec.Body.String())
		}
		var withoutEval evaluateResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &withoutEval); err != nil {
			t.Fatal(err)
		}
		if withEval.Decision != withoutEval.Decision || withEval.DispatchAllowed != withoutEval.DispatchAllowed {
			t.Fatalf("policy decision drifted: with=%+v without=%+v", withEval.Result, withoutEval.Result)
		}
		if !samePolicyOps(withEval.Result, withoutEval.Result) {
			t.Fatalf("policy operations drifted\nwith=%+v\nwithout=%+v", withEval.Operations, withoutEval.Operations)
		}
	})
}

func TestInvalidLayoutDoesNotInventHTTPGraph(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	src := `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: restart-api-rollout
  ui:
    layout:
      version: 1
      nodes:
        restart: { x: 1, y: 2 }
        invented: { x: 9, y: 9 }
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: restart
      type: data.set
      name: Constants
      with:
        value:
          ok: true
  edges: []
`
	body, _ := json.Marshal(map[string]string{"definitionYaml": src})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/normalize", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("normalize: %d %s", rec.Code, rec.Body.String())
	}
	var out normalizeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Summary.Nodes) != 1 || out.Summary.Nodes[0].ID != "restart" {
		t.Fatalf("invented graph nodes: %+v", out.Summary.Nodes)
	}
	if _, ok := out.Summary.UI.Layout.Nodes["invented"]; ok {
		t.Fatal("ghost layout key leaked into summary")
	}
	if strings.Contains(out.DefinitionYAML, "invented") {
		t.Fatalf("ghost node persisted:\n%s", out.DefinitionYAML)
	}

	bad := strings.Replace(src, "      nodes:", "      edges:\n        - from: invented.result\n          to: restart.input\n      nodes:", 1)
	body, _ = json.Marshal(map[string]string{"definitionYaml": bad})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/validate", body, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
	if !problemHasCode(p, workflow.CodeUnknownField) {
		t.Fatalf("layout edges should fail closed: %+v", p.Errors)
	}
}

func samePolicyOps(a, b policy.Result) bool {
	a.EvaluatedAt = b.EvaluatedAt
	a.WorkflowVersionID = b.WorkflowVersionID
	a.WorkflowDigest = b.WorkflowDigest
	return reflect.DeepEqual(a.Operations, b.Operations) &&
		reflect.DeepEqual(a.Requirements, b.Requirements) &&
		reflect.DeepEqual(a.Denied, b.Denied) &&
		a.Decision == b.Decision &&
		a.DispatchAllowed == b.DispatchAllowed
}
