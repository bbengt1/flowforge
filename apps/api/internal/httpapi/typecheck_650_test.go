package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// #650 E3.2 T10: the draft type-check route never evaluates, is gated on
// workflow.edit + CSRF, is rate-limited, returns types/codes/paths only and
// resolves references only inside the draft. Plus the publish half: FFX
// errors block publish, refs and catalogRevision are recorded.

func ffxHTTPYAML(when string, wired bool) string {
	// Unwired keeps the graph connected through check.loose, so only the
	// config input loses its upstream step.
	edges := "  edges:\n    - from: constants.result\n      to: check.loose\n"
	if wired {
		edges = "  edges:\n    - from: constants.result\n      to: check.config\n"
	}
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: FFX Draft
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
          marker: zq7VALUEzq7
    - id: check
      type: test.ffx
      name: Check
      with:
        when: {expr: '` + when + `'}
` + edges
}

type typecheckBody struct {
	OK              bool `json:"ok"`
	CatalogRevision int  `json:"catalogRevision"`
	Expressions     []struct {
		NodeID, Field, Path, Type string
	} `json:"expressions"`
	Errors []workflow.FieldError `json:"errors"`
}

func TestDraftTypecheck650(t *testing.T) {
	workflow.EnableExpressionTestNode()
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"tc-viewer","display_name":"Viewer","role_keys":["viewer"]}`).User
	editor := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"tc-editor","display_name":"Editor","role_keys":["editor"]}`).User

	created := createWorkflow(t, h, admin, tenant, ws, ffxHTTPYAML(`input.config.env == "staging" && item.total > 1000`, true))
	path := "/api/v1/workflows/" + created.Workflow.ID + "/draft/typecheck"
	post := func(user identity.User) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceRequest(http.MethodPost, path, nil, user, tenant, ws))
		return rec
	}
	decode := func(rec *httptest.ResponseRecorder) typecheckBody {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("typecheck = %d %s", rec.Code, rec.Body.String())
		}
		var b typecheckBody
		if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
			t.Fatal(err)
		}
		return b
	}

	t.Run("typecheck_requires_workflow_edit", func(t *testing.T) {
		if rec := post(viewer); rec.Code != http.StatusForbidden {
			t.Fatalf("viewer = %d %s", rec.Code, rec.Body.String())
		}
		decode(post(editor))
	})

	t.Run("typecheck_returns_types_only", func(t *testing.T) {
		rec := post(admin)
		b := decode(rec)
		if !b.OK || b.CatalogRevision != workflow.CatalogRevision || len(b.Expressions) != 1 {
			t.Fatalf("body = %s", rec.Body.String())
		}
		e := b.Expressions[0]
		if e.NodeID != "check" || e.Field != "when" || e.Type != "bool" || e.Path != "spec.nodes[check].with.when.expr" {
			t.Fatalf("expression = %+v", e)
		}
		var raw map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &raw)
		keys := make([]string, 0, len(raw))
		for k := range raw {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		if strings.Join(keys, ",") != "catalogRevision,draftRevision,errors,expressions,ok" {
			t.Fatalf("response keys = %v", keys)
		}
		for _, leak := range []string{"zq7VALUEzq7", "staging", "1000", "input.config"} {
			if strings.Contains(rec.Body.String(), leak) {
				t.Fatalf("response carries %q: %s", leak, rec.Body.String())
			}
		}
	})

	t.Run("typecheck_refs_scoped_to_draft", func(t *testing.T) {
		// Publish the wired version, then save a draft without the edge:
		// the reference resolves against the draft only.
		pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "wired")
		if pub.Version.CatalogRevision == nil || *pub.Version.CatalogRevision != workflow.CatalogRevision {
			t.Fatalf("catalogRevision = %v", pub.Version.CatalogRevision)
		}
		if len(pub.Version.Summary.Expressions) != 1 || pub.Version.Summary.Expressions[0].Inputs[0].From != "constants.result" {
			t.Fatalf("recorded refs = %+v", pub.Version.Summary.Expressions)
		}
		unwired := ffxHTTPYAML(`input.config.env == "staging"`, false)
		rec := putDraftRaw(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, unwired)
		if rec.Code != http.StatusOK {
			t.Fatalf("unwired draft did not save (%d): %s", rec.Code, rec.Body.String())
		}
		b := decode(post(admin))
		if b.OK || len(b.Errors) != 1 || b.Errors[0].Code != workflow.CodeExpressionRefNotAncestor || b.Errors[0].NodeID != "check" || b.Errors[0].Line != 0 {
			t.Fatalf("body = %+v", b)
		}
	})

	t.Run("cross_workspace_404", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedRequest(http.MethodPost, "/api/v1/workspaces", strings.NewReader(`{"tenant_slug":"acme","workbench_key":"tc-other","name":"Other"}`))
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("other ws: %d %s", rec.Code, rec.Body.String())
		}
		other := httptest.NewRecorder()
		r := workspaceRequest(http.MethodPost, path, nil, admin, tenant, ws)
		r.Header.Set(headerWorkbenchKey, "tc-other")
		r.Header.Del(headerWorkspaceID)
		h.ServeHTTP(other, r)
		if other.Code != http.StatusNotFound {
			t.Fatalf("cross workspace = %d %s", other.Code, other.Body.String())
		}
	})

	t.Run("no_draft_eval_route", func(t *testing.T) {
		for _, p := range []string{"/draft/evaluate", "/draft/eval", "/draft/run", "/draft/preview", "/draft/executions"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+p, []byte(`{}`), admin, tenant, ws))
			if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s = %d", p, rec.Code)
			}
		}
		spec, err := os.ReadFile("../../openapi/openapi.yaml")
		if err != nil {
			t.Fatal(err)
		}
		re := regexp.MustCompile(`(?m)^  /workflows/\{workflowId\}/draft/([A-Za-z-]+):`)
		for _, m := range re.FindAllStringSubmatch(string(spec), -1) {
			if m[1] != "typecheck" {
				t.Fatalf("unexpected draft sub-route %q", m[1])
			}
		}
	})
}

// T10 typecheck_rate_limited: per user, then 429.
func TestDraftTypecheckRateLimited650(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, manualHTTPYAML)
	path := "/api/v1/workflows/" + created.Workflow.ID + "/draft/typecheck"
	for i := 0; i < 60; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, workspaceRequest(http.MethodPost, path, nil, admin, tenant, ws))
		if rec.Code != http.StatusOK {
			t.Fatalf("call %d = %d %s", i, rec.Code, rec.Body.String())
		}
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceRequest(http.MethodPost, path, nil, admin, tenant, ws))
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("61st = %d %s", rec.Code, rec.Body.String())
	}
}

// T10 typecheck_requires_csrf: a cookie session without the CSRF token is
// refused before the handler runs.
func TestDraftTypecheckRequiresCSRF650(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     store,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: wfstore.NewMemory(),
	}))
	owner := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	for _, step := range []struct{ path, body string }{
		{"/api/v1/tenants", `{"slug":"acme","name":"Acme"}`},
		{"/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, identifiedJSON(http.MethodPost, step.path, step.body, owner))
		if rec.Code != http.StatusCreated {
			t.Fatalf("%s: %d %s", step.path, rec.Code, rec.Body.String())
		}
	}
	ws, tenant := currentWorkspace(t, h, owner)
	created := createWorkflow(t, h, owner, tenant, ws, manualHTTPYAML)
	seedLocalLogin(t, store, "https://idp.example", "tc-local-admin", "Local Admin", "correct-horse")
	putMember(t, h, owner, tenant, ws, `{"issuer":"https://idp.example","external_subject":"tc-local-admin","display_name":"Local Admin","role_keys":["admin"]}`)
	token, csrf := loginLocal(t, h, "tc-local-admin", "correct-horse")
	path := "/api/v1/workflows/" + created.Workflow.ID + "/draft/typecheck"

	bad := httptest.NewRecorder()
	h.ServeHTTP(bad, sessionWorkspaceRequest(http.MethodPost, path, token, "", tenant, ws))
	if bad.Code != http.StatusForbidden {
		t.Fatalf("no csrf = %d %s", bad.Code, bad.Body.String())
	}
	good := httptest.NewRecorder()
	h.ServeHTTP(good, sessionWorkspaceRequest(http.MethodPost, path, token, csrf, tenant, ws))
	if good.Code != http.StatusOK {
		t.Fatalf("with csrf = %d %s", good.Code, good.Body.String())
	}
}

// Publish half: an FFX error blocks publish with the node id and no
// line/column; nothing is published.
func TestPublishRejectsBadExpression650(t *testing.T) {
	workflow.EnableExpressionTestNode()
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, ffxHTTPYAML(`vars.k == "x"`, true))
	body, _ := json.Marshal(map[string]any{"revision": created.Draft.Revision})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceJSON(http.MethodPost, "/api/v1/workflows/"+created.Workflow.ID+"/publish", body, admin, tenant, ws))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), workflow.CodeExpressionSecretUse) || !strings.Contains(rec.Body.String(), `"nodeId":"check"`) {
		t.Fatalf("publish = %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"line"`) {
		t.Fatalf("publish error carries a line: %s", rec.Body.String())
	}
	versions := httptest.NewRecorder()
	h.ServeHTTP(versions, workspaceRequest(http.MethodGet, "/api/v1/workflows/"+created.Workflow.ID+"/versions", nil, admin, tenant, ws))
	if !strings.Contains(versions.Body.String(), `[]`) {
		t.Fatalf("a version was published: %s", versions.Body.String())
	}
}
