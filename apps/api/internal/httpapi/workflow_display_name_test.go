package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// displayNameErrorMessage is the invalid-name text. The field is the one
// the client sent: "name" on JSON create, "metadata.name" on YAML validate
// and draft save.
func displayNameErrorMessage(field string) string {
	return field + " must be 1-200 characters with no surrounding space and no control, format, or line/paragraph separator characters."
}

func assertDisplayNameField(t *testing.T, p Problem, path string) {
	t.Helper()
	want := displayNameErrorMessage(path)
	if p.Code != CodeInvalidWorkflow {
		t.Fatalf("code = %q", p.Code)
	}
	if p.Detail != want {
		t.Fatalf("detail = %q, want %q", p.Detail, want)
	}
	if len(p.Errors) != 1 {
		t.Fatalf("errors = %+v", p.Errors)
	}
	e := p.Errors[0]
	if e.Code != "invalid-name" || e.Path != path || e.Message != want {
		t.Fatalf("error = %+v, want path %s message %q", e, path, want)
	}
}

func TestDisplayNameErrorPathMatchesSentField(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	const base = `
apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: NAME
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
	yamlFor := func(title string) string {
		return strings.Replace(base, "name: NAME", "name: "+strconv.Quote(title), 1)
	}
	failures := []struct {
		name  string
		title string
		// jsonNameRejects is set when the JSON create body field name is an
		// invalid-name error. Empty and whitespace-only stay accepted: they
		// are an omitted override and the YAML metadata.name is stored.
		jsonNameRejects bool
	}{
		{name: "empty", title: ""},
		{name: "whitespace-only", title: " \t "},
		{name: "too-long", title: strings.Repeat("n", 201), jsonNameRejects: true},
		{name: "zero-width-space", title: "Deploy\u200bAPI", jsonNameRejects: true},
	}

	for _, tc := range failures {
		t.Run("yaml-validate/"+tc.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := workspaceRequest(http.MethodPost, "/api/v1/workflows/validate", strings.NewReader(yamlFor(tc.title)), admin, tenant, ws)
			req.Header.Set("Content-Type", "application/yaml")
			h.ServeHTTP(rec, req)
			p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
			assertDisplayNameField(t, p, "metadata.name")
		})

		t.Run("draft-save/"+tc.name, func(t *testing.T) {
			good := "Save " + tc.name
			created := createWorkflow(t, h, admin, tenant, ws, yamlFor(good))
			body, err := json.Marshal(map[string]any{
				"revision":       created.Draft.Revision,
				"definitionYaml": yamlFor(tc.title),
			})
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			req := workspaceJSON(http.MethodPut, "/api/v1/workflows/"+created.Workflow.ID+"/draft", body, admin, tenant, ws)
			h.ServeHTTP(rec, req)
			p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
			assertDisplayNameField(t, p, "metadata.name")
		})

		t.Run("json-create/definition/"+tc.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]string{"definitionYaml": yamlFor(tc.title)})
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			req := workspaceJSON(http.MethodPost, "/api/v1/workflows", body, admin, tenant, ws)
			h.ServeHTTP(rec, req)
			p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
			assertDisplayNameField(t, p, "metadata.name")
		})

		t.Run("json-create/name/"+tc.name, func(t *testing.T) {
			good := "Create " + tc.name
			body, err := json.Marshal(map[string]string{
				"definitionYaml": yamlFor(good),
				"name":           tc.title,
			})
			if err != nil {
				t.Fatal(err)
			}
			rec := httptest.NewRecorder()
			req := workspaceJSON(http.MethodPost, "/api/v1/workflows", body, admin, tenant, ws)
			h.ServeHTTP(rec, req)
			if !tc.jsonNameRejects {
				if rec.Code != http.StatusCreated {
					t.Fatalf("omitted name override: %d %s", rec.Code, rec.Body.String())
				}
				var out workflowDetailResponse
				if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
					t.Fatal(err)
				}
				if out.Workflow.Name != good {
					t.Fatalf("stored name = %q, want YAML name %q", out.Workflow.Name, good)
				}
				return
			}
			p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidWorkflow, "caller-request-16")
			assertDisplayNameField(t, p, "name")
		})
	}
}
