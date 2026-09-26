package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestEmbedSessionCannotDeleteWorkflow(t *testing.T) {
	env := newEmbedEnv(t)
	ws, tenant := currentWorkspace(t, env.h, env.admin)
	owned := createWorkflow(t, env.h, env.admin, tenant, ws, strings.Replace(validWorkflowYAML, "name: restart-api-rollout", "name: embed-owned", 1))
	other := putMember(t, env.h, env.admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"embed-other","display_name":"Other","role_keys":["admin"]}`)
	foreign := createWorkflow(t, env.h, other.User, tenant, ws, strings.Replace(validWorkflowYAML, "name: restart-api-rollout", "name: embed-foreign", 1))

	t.Run("owner view cap", func(t *testing.T) {
		assertEmbedDeleteRefused(t, env, owned.Workflow.ID)
	})
	t.Run("owner view and edit", func(t *testing.T) {
		token, csrf := exchangeEmbedSession(t, env, env.admin, []string{authz.PermWorkflowView, authz.PermWorkflowEdit})
		assertEmbedWorkflowDeleteFalse(t, env, token, csrf, owned.Workflow.ID)
	})
	t.Run("other admin view and edit", func(t *testing.T) {
		token, csrf := exchangeEmbedSession(t, env, other.User, []string{authz.PermWorkflowView, authz.PermWorkflowEdit})
		assertEmbedWorkflowDeleteFalse(t, env, token, csrf, foreign.Workflow.ID)
	})

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+owned.Workflow.ID, nil, env.admin, tenant, ws)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("workflow still exists: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbedStoredWorkflowDeleteCannotDelete(t *testing.T) {
	env := newEmbedEnv(t)
	ws, tenant := currentWorkspace(t, env.h, env.admin)
	owned := createWorkflow(t, env.h, env.admin, tenant, ws, strings.Replace(validWorkflowYAML, "name: restart-api-rollout", "name: embed-prefixed", 1))
	token, csrf := plantEmbedSession(t, env, []string{authz.PermWorkflowView, authz.PermWorkflowDelete})
	assertEmbedWorkflowDeleteFalse(t, env, token, csrf, owned.Workflow.ID)

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workflows/"+owned.Workflow.ID, nil, env.admin, tenant, ws)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("workflow still exists: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbedViewOnlyOwnerCannotEscalate(t *testing.T) {
	env := newEmbedEnv(t)
	ws, tenant := currentWorkspace(t, env.h, env.admin)
	const yamlSrc = `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: embed-view-only
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Stop
  edges: []
`
	owned := createWorkflow(t, env.h, env.admin, tenant, ws, yamlSrc)
	pub := publishWorkflow(t, env.h, env.admin, tenant, ws, owned.Workflow.ID, owned.Draft.Revision, "view-only")
	token, csrf := exchangeEmbedSession(t, env, env.admin, []string{authz.PermWorkflowView})

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPut, "/api/v1/workflows/"+owned.Workflow.ID+"/draft", `{"definitionYaml":"apiVersion: flowforge/v1\n","revision":1}`, token, csrf)
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/workflows/"+owned.Workflow.ID+"/publish", `{"revision":1}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPatch, "/api/v1/triggers/11111111-1111-4111-8111-111111111111", `{}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/triggers/11111111-1111-4111-8111-111111111111/enable", `{}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPatch, "/api/v1/schedules/22222222-2222-4222-8222-222222222222", `{"interval":"PT30M"}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/schedules/22222222-2222-4222-8222-222222222222/enable", `{}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/workflows/"+owned.Workflow.ID+"/versions/"+pub.Version.ID+"/export", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("export uses workflow.view and must stay allowed: %d %s", rec.Code, rec.Body.String())
	}
}

func plantEmbedSession(t *testing.T, env embedEnv, caps []string) (token, csrf string) {
	t.Helper()
	ws, tenant := currentWorkspace(t, env.h, env.admin)
	issued, err := env.sessions.Create(t.Context(), env.admin.ID, *env.now, session.DefaultIdleTimeout, session.DefaultAbsoluteTimeout, session.CreateOpts{
		AuthMethod: session.AuthMethodEmbed,
		Binding: session.Binding{
			TenantID:     tenant.ID,
			WorkbenchKey: ws.WorkbenchKey,
			WorkspaceID:  ws.ID,
			Capabilities: append([]string(nil), caps...),
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return issued.Token, issued.CSRF
}

func assertEmbedDeleteRefused(t *testing.T, env embedEnv, workflowID string) {
	t.Helper()
	token, csrf := exchangeEmbedSession(t, env, env.admin, []string{authz.PermWorkflowView})
	assertEmbedWorkflowDeleteFalse(t, env, token, csrf, workflowID)
}

func assertEmbedWorkflowDeleteFalse(t *testing.T, env embedEnv, token, csrf, workflowID string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/workflows/"+workflowID, "", token, csrf)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("embed get: %d %s", rec.Code, rec.Body.String())
	}
	var view struct {
		Capabilities struct {
			Delete bool `json:"delete"`
		} `json:"capabilities"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if view.Capabilities.Delete {
		t.Fatal("embed capabilities.delete must be false")
	}
	if strings.Contains(rec.Body.String(), "deleteImpact") {
		t.Fatal("embed detail must omit deleteImpact")
	}
	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodDelete, "/api/v1/workflows/"+workflowID, "", token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}
