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
		p := assertProblem(t, rec, http.StatusConflict, CodeWorkflowSlugTaken, "")
		assertSlugField(t, p)
		if p.SuggestedSlug != "taken-live-2" {
			t.Fatalf("suggestedSlug = %q", p.SuggestedSlug)
		}
		list := listWorkflowSlugs(t, h, admin, tenant, ws)
		if list["taken-live-2"] {
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
		if p.SuggestedSlug != "taken-gone-2" {
			t.Fatalf("suggestedSlug = %q", p.SuggestedSlug)
		}
	})

	t.Run("re-import gets suggestedSlug and a stale one gets a fresh one", func(t *testing.T) {
		exported := slugHTTPYAML("Imported", "import-me")
		postWorkflow(t, h, admin, tenant, ws, map[string]string{"definitionYaml": exported}, http.StatusCreated)
		rec := postWorkflowRaw(t, h, admin, tenant, ws, map[string]string{"definitionYaml": exported})
		p := assertProblem(t, rec, http.StatusConflict, CodeWorkflowSlugTaken, "")
		assertSlugField(t, p)
		if p.SuggestedSlug != "import-me-2" {
			t.Fatalf("suggestedSlug = %q", p.SuggestedSlug)
		}
		// Someone else takes the suggestion first.
		postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Racer", ""),
			"slug":           p.SuggestedSlug,
		}, http.StatusCreated)
		rec = postWorkflowRaw(t, h, admin, tenant, ws, map[string]string{"definitionYaml": exported, "slug": p.SuggestedSlug})
		stale := assertProblem(t, rec, http.StatusConflict, CodeWorkflowSlugTaken, "")
		assertSlugField(t, stale)
		if stale.SuggestedSlug != "import-me-3" {
			t.Fatalf("fresh suggestedSlug = %q", stale.SuggestedSlug)
		}
		done := postWorkflow(t, h, admin, tenant, ws, map[string]string{"definitionYaml": exported, "slug": stale.SuggestedSlug}, http.StatusCreated)
		if done.Workflow.Slug != "import-me-3" {
			t.Fatalf("one-click import slug = %q", done.Workflow.Slug)
		}
		assertDraftSlug(t, done.Draft.DefinitionYAML, "import-me-3")
	})

	t.Run("new slugs with bad hyphens are 400 on slug", func(t *testing.T) {
		rec := postWorkflowRaw(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Trail", ""),
			"slug":           "qa-546-trail-",
		})
		assertSlugField(t, assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, ""))
		rec = postWorkflowRaw(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Double", "double--hyphen"),
		})
		assertSlugField(t, assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, ""))
	})

	t.Run("21 name-only blank drafts with deletes mixed all succeed", func(t *testing.T) {
		seen := map[string]bool{}
		for i := 0; i < 21; i++ {
			created := postWorkflow(t, h, admin, tenant, ws, map[string]string{
				"definitionYaml": slugHTTPYAML("Blank draft", ""),
				"name":           "Blank draft",
			}, http.StatusCreated)
			if seen[created.Workflow.Slug] {
				t.Fatalf("duplicate slug %q", created.Workflow.Slug)
			}
			seen[created.Workflow.Slug] = true
			if i%2 == 1 {
				deleteWorkflow(t, h, admin, tenant, ws, created.Workflow.ID)
			}
		}
		if !seen["blank-draft"] || !seen["blank-draft-21"] {
			t.Fatalf("slugs = %v", seen)
		}
	})

	t.Run("draft save cannot change metadata.slug", func(t *testing.T) {
		created := postWorkflow(t, h, admin, tenant, ws, map[string]string{
			"definitionYaml": slugHTTPYAML("Fixed", ""),
			"name":           "Fixed Slug",
		}, http.StatusCreated)
		rec := putDraftRaw(t, h, admin, tenant, ws, created.Workflow.ID, 1, slugHTTPYAML("Fixed Slug", "renamed-slug"))
		p := assertProblem(t, rec, http.StatusBadRequest, CodeSlugImmutable, "")
		assertSlugField(t, p)
		if !strings.Contains(p.Detail, "Rename") {
			t.Fatalf("detail = %q", p.Detail)
		}
		rec = putDraftRaw(t, h, admin, tenant, ws, created.Workflow.ID, 1, slugHTTPYAML("Fixed Slug v2", ""))
		if rec.Code != http.StatusOK {
			t.Fatalf("save: %d %s", rec.Code, rec.Body.String())
		}
		var saved workflowDetailResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &saved); err != nil {
			t.Fatal(err)
		}
		assertDraftSlug(t, saved.Draft.DefinitionYAML, "fixed-slug")
		if saved.Workflow.Slug != "fixed-slug" || saved.Workflow.Name != "Fixed Slug v2" {
			t.Fatalf("saved = %+v", saved.Workflow)
		}
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

func putDraftRaw(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace, id string, revision int64, yamlDoc string) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"revision": revision, "definitionYaml": yamlDoc})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPut, "/api/v1/workflows/"+id+"/draft", raw, user, tenant, ws))
	return rec
}

func listWorkflowSlugs(t *testing.T, h http.Handler, user identity.User, tenant identity.Tenant, ws identity.Workspace) map[string]bool {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/workflows?limit=100", nil, user, tenant, ws))
	if rec.Code != http.StatusOK {
		t.Fatalf("list: %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		Items []struct {
			Slug string `json:"slug"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	slugs := map[string]bool{}
	for _, item := range out.Items {
		slugs[item.Slug] = true
	}
	return slugs
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
