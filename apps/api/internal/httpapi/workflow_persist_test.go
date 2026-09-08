package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const editedWorkflowYAML = `apiVersion: flowforge/v1
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
      name: Restart API v2
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

func TestWorkflowDraftPublishCompareRestoreAndPin(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	created := createWorkflow(t, h, admin, tenant, ws, validWorkflowYAML)
	if created.Workflow.Status != wfstore.StatusDraft || created.Draft.Revision != 1 {
		t.Fatalf("create: %+v", created)
	}

	t.Run("draft cannot run", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"source": "draft"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/executions", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
		if !strings.Contains(rec.Body.String(), "Drafts cannot be executed") {
			t.Fatalf("detail = %s", rec.Body.String())
		}
	})

	t.Run("conflict-safe save", func(t *testing.T) {
		stale, _ := json.Marshal(map[string]any{"revision": 99, "definitionYaml": editedWorkflowYAML})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", stale, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")

		okBody, _ := json.Marshal(map[string]any{"revision": 1, "definitionYaml": editedWorkflowYAML})
		rec = httptest.NewRecorder()
		req = workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", okBody, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
		}
		var saved workflowDetailResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		if saved.Draft.Revision != 2 || saved.Draft.Summary.Nodes[0].Name != "Restart API v2" {
			t.Fatalf("saved = %+v", saved.Draft)
		}
		created = saved
	})

	t.Run("invalid yaml is not persisted", func(t *testing.T) {
		body, _ := json.Marshal(map[string]any{"revision": 2, "definitionYaml": "apiVersion: [broken"})
		rec := httptest.NewRecorder()
		req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", body, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
	})

	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, 2, "first release")
	if pub.Version.VersionNumber != 1 || pub.Workflow.Status != wfstore.StatusPublished {
		t.Fatalf("publish: %+v", pub)
	}

	t.Run("export is immutable snapshot", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/versions/"+pub.Version.ID+"/export", nil, admin, tenant, ws)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("export: %d %s", rec.Code, rec.Body.String())
		}
		var exp exportResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &exp); err != nil {
			t.Fatal(err)
		}
		if exp.Digest != pub.Version.Digest || exp.DefinitionYAML != pub.Version.DefinitionYAML {
			t.Fatalf("export drifted: %+v", exp)
		}
	})

	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	if exec.WorkflowDigest != pub.Version.Digest {
		t.Fatalf("exec pin = %+v", exec)
	}

	okBody, _ := json.Marshal(map[string]any{"revision": 2, "definitionYaml": validWorkflowYAML})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", okBody, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("later edit: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/executions/"+exec.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("get exec: %d %s", rec.Code, rec.Body.String())
	}
	var pinned wfstore.Execution
	if err := json.Unmarshal(rec.Body.Bytes(), &pinned); err != nil {
		t.Fatal(err)
	}
	if pinned.WorkflowDigest != pub.Version.Digest || pinned.WorkflowVersionID != pub.Version.ID {
		t.Fatalf("execution drifted after edit: %+v", pinned)
	}

	cmpBody, _ := json.Marshal(map[string]any{
		"left":  map[string]any{"kind": "version", "versionId": pub.Version.ID},
		"right": map[string]any{"kind": "draft"},
	})
	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/compare", cmpBody, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("compare: %d %s", rec.Code, rec.Body.String())
	}
	var diff wfstore.CompareResult
	if err := json.Unmarshal(rec.Body.Bytes(), &diff); err != nil {
		t.Fatal(err)
	}
	if diff.Equal || diff.DigestMatch {
		t.Fatalf("expected difference after edit: %+v", diff)
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/versions/"+pub.Version.ID+"/restore", []byte(`{"expectedRevision":3}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	var restored workflowDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Draft.Digest != pub.Version.Digest || restored.Draft.Revision != 4 {
		t.Fatalf("restore draft = %+v", restored.Draft)
	}
}

func TestWorkflowRBACAndHostIdentity(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, validWorkflowYAML)

	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-draft-viewer","role_keys":["viewer"]}`)
	editor := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-draft-editor","role_keys":["editor"]}`)
	operator := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"wf-draft-operator","role_keys":["operator"]}`)

	body, _ := json.Marshal(map[string]any{"revision": 1, "definitionYaml": editedWorkflowYAML})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", body, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/publish", []byte(`{"revision":1}`), editor.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", body, operator.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")

	if contains(viewer.Permissions, authz.PermWorkflowEdit) {
		t.Fatal("viewer should not edit")
	}

	rec = httptest.NewRecorder()
	req = workspaceJSON(http.MethodPost, "/api/v1/workflows", []byte(`{"workspace_id":"11111111-1111-4111-8111-111111111111","definitionYaml":`+mustJSON(validWorkflowYAML)+`}`), admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
}

func TestWorkflowMethodNotAllowedOnPersistRoutes(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodDelete, "/api/v1/workflows", nil))
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "")
}

func createWorkflow(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, yamlSrc string) workflowDetailResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"definitionYaml": yamlSrc})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workflow: %d %s", rec.Code, rec.Body.String())
	}
	var out workflowDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func publishWorkflow(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID string, revision int64, note string) publishResponse {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"revision": revision, "note": note})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+workflowID+"/publish", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("publish: %d %s", rec.Code, rec.Body.String())
	}
	var out publishResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func startExecution(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, workflowID, versionID string) wfstore.Execution {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"workflowVersionId": versionID})
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows/"+workflowID+"/executions", body, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("start execution: %d %s", rec.Code, rec.Body.String())
	}
	var out wfstore.Execution
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func mustJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
