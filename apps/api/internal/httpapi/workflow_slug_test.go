package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

func TestWorkflowCreateDerivesSlugFromName(t *testing.T) {
	h, admin, tenant, ws := slugWorkspace(t)

	t.Run("name only survives a soft delete", func(t *testing.T) {
		first := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("blank-draft", ""),
			"name":           "Redeploy",
		}, http.StatusCreated)
		if first.Workflow.Slug != "redeploy" || first.Workflow.Name != "Redeploy" {
			t.Fatalf("first = name %q slug %q", first.Workflow.Name, first.Workflow.Slug)
		}
		assertDraftSlug(t, first.Draft.DefinitionYAML, "redeploy")
		deleteWorkflow(t, h, admin, tenant, ws, first.Workflow.ID)

		second := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("blank-draft", ""),
			"name":           "Redeploy",
		}, http.StatusCreated)
		if second.Workflow.Slug != "redeploy-2" {
			t.Fatalf("second slug = %q", second.Workflow.Slug)
		}
		assertDraftSlug(t, second.Draft.DefinitionYAML, "redeploy-2")
	})

	t.Run("same name is x and x-2", func(t *testing.T) {
		a := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("blank-draft", ""),
			"name":           "X",
		}, http.StatusCreated)
		b := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("blank-draft", ""),
			"name":           "X",
		}, http.StatusCreated)
		if a.Workflow.Slug != "x" || b.Workflow.Slug != "x-2" {
			t.Fatalf("slugs = %q %q", a.Workflow.Slug, b.Workflow.Slug)
		}
	})

	t.Run("explicit live clash stays on slug", func(t *testing.T) {
		postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Other", ""),
			"name":           "Other",
			"slug":           "taken-live",
		}, http.StatusCreated)
		rec := postWorkflowRaw(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Again", ""),
			"name":           "Again",
			"slug":           "taken-live",
		})
		p := assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
		assertSlugField(t, p)
		if strings.Contains(rec.Body.String(), "taken-live-2") {
			t.Fatal("explicit slug was rewritten")
		}
	})

	t.Run("explicit deleted clash stays on slug", func(t *testing.T) {
		created := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Gone", ""),
			"slug":           "taken-gone",
		}, http.StatusCreated)
		deleteWorkflow(t, h, admin, tenant, ws, created.Workflow.ID)
		rec := postWorkflowRaw(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Next", ""),
			"slug":           "taken-gone",
		})
		p := assertProblem(t, rec, http.StatusConflict, CodeWorkflowSlugReserved, "")
		assertSlugField(t, p)
	})

	t.Run("emoji name falls back to workflow", func(t *testing.T) {
		created := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("placeholder", ""),
			"name":           "🎉",
		}, http.StatusCreated)
		if created.Workflow.Slug != "workflow" {
			t.Fatalf("slug = %q", created.Workflow.Slug)
		}
		assertDraftSlug(t, created.Draft.DefinitionYAML, "workflow")
	})

	t.Run("reserved derived word is suffixed", func(t *testing.T) {
		created := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("placeholder", ""),
			"name":           "Catalog",
		}, http.StatusCreated)
		if created.Workflow.Slug != "catalog-2" {
			t.Fatalf("slug = %q", created.Workflow.Slug)
		}
		assertDraftSlug(t, created.Draft.DefinitionYAML, "catalog-2")
	})

	t.Run("yaml slug beats a derived name and body slug beats yaml", func(t *testing.T) {
		fromYAML := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Deploy API", "from-yaml"),
			"name":           "Deploy API",
		}, http.StatusCreated)
		if fromYAML.Workflow.Slug != "from-yaml" {
			t.Fatalf("yaml slug = %q", fromYAML.Workflow.Slug)
		}
		assertDraftSlug(t, fromYAML.Draft.DefinitionYAML, "from-yaml")

		fromBody := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Deploy API", "from-yaml-body"),
			"name":           "Deploy API",
			"slug":           "from-body",
		}, http.StatusCreated)
		if fromBody.Workflow.Slug != "from-body" {
			t.Fatalf("body slug = %q", fromBody.Workflow.Slug)
		}
		assertDraftSlug(t, fromBody.Draft.DefinitionYAML, "from-body")
	})
}

func slugWorkspace(t *testing.T) (http.Handler, identity.User, identity.Tenant, identity.Workspace) {
	t.Helper()
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	return h, admin, tenant, ws
}

func slugHTTPYAML(name, slug string) string {
	slugLine := ""
	if slug != "" {
		slugLine = "\n  slug: " + slug
	}
	return fmt.Sprintf(`apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: %s%s
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: done
      type: flow.stop
      name: Stop
  edges: []
`, strconv.Quote(name), slugLine)
}

func postWorkflow(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, body map[string]string, status int) workflowDetailResponse {
	t.Helper()
	rec := postWorkflowRaw(t, h, user, tenant, ws, body)
	if rec.Code != status {
		t.Fatalf("status = %d, want %d body=%s", rec.Code, status, rec.Body.String())
	}
	var out workflowDetailResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func postWorkflowRaw(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, body map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/workflows", raw, user, tenant, ws)
	h.ServeHTTP(rec, req)
	return rec
}

func deleteWorkflow(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, id string) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodDelete, "/api/v1/workflows/"+id, nil, user, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
}

func assertSlugField(t *testing.T, p Problem) {
	t.Helper()
	if len(p.Errors) != 1 {
		t.Fatalf("errors = %+v", p.Errors)
	}
	e := p.Errors[0]
	if e.Path != "slug" || e.Code != p.Code || e.Message == "" || e.Message != p.Detail {
		t.Fatalf("slug error = %+v problem %+v", e, p)
	}
}

func assertDraftSlug(t *testing.T, yamlDoc, slug string) {
	t.Helper()
	doc, errs := workflow.Parse([]byte(yamlDoc))
	if len(errs) > 0 || doc == nil || doc.Metadata.Slug != slug {
		t.Fatalf("draft slug = %q errs=%+v\n%s", slug, errs, yamlDoc)
	}
	if workflow.Digest(yamlDoc) == "" || !strings.Contains(yamlDoc, "slug: "+slug) {
		t.Fatalf("draft yaml missing slug %q\n%s", slug, yamlDoc)
	}
}
