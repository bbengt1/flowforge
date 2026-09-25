package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
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
	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodDelete, "/api/v1/workflows/"+workflowID, "", token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}
