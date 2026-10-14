package httpapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/itemcursor"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// #650 E3.1 T1 (API half): paged items under RLS with an HMAC cursor.

type itemsPage struct {
	Items      []wfstore.StepItem `json:"items"`
	Total      int                `json:"total"`
	NextCursor string             `json:"nextCursor"`
}

func TestStepItemsAPI650(t *testing.T) {
	var frozen atomic.Int64
	frozen.Store(time.Now().UTC().UnixNano())
	clock := func() time.Time { return time.Unix(0, frozen.Load()).UTC() }
	kr := itemcursor.NewRandom()
	keys := vault.TestKeys()
	workflows := wfstore.NewMemory()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:       identity.NewMemory(),
		Scoped:      isolation.NewMemory(),
		Sessions:    session.NewMemory(),
		Workflows:   workflows,
		Ops:         ops,
		Hooks:       hooks,
		Vault:       vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:        keys,
		Now:         clock,
		ItemsCursor: kr,
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	for _, step := range []struct{ path, body string }{
		{"/api/v1/tenants", `{"slug":"acme","name":"Acme"}`},
		{"/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`},
		{"/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"other","name":"Other"}`},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, identifiedJSON(http.MethodPost, step.path, step.body, admin))
		if rec.Code != http.StatusCreated {
			t.Fatalf("%s: %d %s", step.path, rec.Code, rec.Body.String())
		}
	}
	ws, tenant := currentWorkspace(t, h, admin)
	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "items")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	detail := fetchExecutionDetail(t, h, admin, tenant, ws, exec.ID)
	stepID := detail.Steps[0].ID
	scope, err := isolation.Authorize(ws.ID, "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	items := make([]map[string]any, 230)
	for i := range items {
		items[i] = map[string]any{"n": i, "token": "tok-secret-value"}
	}
	if _, err := workflows.PutStepItems(t.Context(), scope, wfstore.PutStepItemsInput{
		ExecutionID: exec.ID, StepID: stepID, Ports: []wfstore.PortItems{{Port: "main", Items: items}},
	}); err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/executions/" + exec.ID + "/steps/" + stepID + "/items"
	get := func(path string, wsKey string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		req := identifiedRequest(http.MethodGet, path, nil)
		req.Header.Set(headerIssuer, admin.Issuer)
		req.Header.Set(headerSubject, admin.ExternalSubject)
		req.Header.Set(headerTenantSlug, "acme")
		req.Header.Set(headerWorkbenchKey, wsKey)
		h.ServeHTTP(rec, req)
		return rec
	}
	decode := func(rec *httptest.ResponseRecorder) itemsPage {
		t.Helper()
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d %s", rec.Code, rec.Body.String())
		}
		var p itemsPage
		if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
			t.Fatal(err)
		}
		return p
	}

	var firstCursor string
	t.Run("items_limit_capped_100 items_total_from_summary paging", func(t *testing.T) {
		p := decode(get(base+"?port=main&limit=500", "ops"))
		if len(p.Items) != 100 || p.Total != 230 || p.NextCursor == "" {
			t.Fatalf("page = %d total=%d next=%q", len(p.Items), p.Total, p.NextCursor)
		}
		firstCursor = p.NextCursor
		seen := len(p.Items)
		for p.NextCursor != "" {
			p = decode(get(base+"?port=main&limit=100&cursor="+url.QueryEscape(p.NextCursor), "ops"))
			for _, it := range p.Items {
				if it.Idx != seen {
					t.Fatalf("idx %d want %d", it.Idx, seen)
				}
				seen++
			}
		}
		if seen != 230 {
			t.Fatalf("seen = %d", seen)
		}
	})
	t.Run("items are redacted", func(t *testing.T) {
		rec := get(base+"?port=main&limit=5", "ops")
		if strings.Contains(rec.Body.String(), "tok-secret-value") {
			t.Fatal("secret in items response")
		}
	})
	t.Run("items_rls_cross_workspace API 404", func(t *testing.T) {
		assertProblem(t, get(base+"?port=main", "other"), http.StatusNotFound, CodeNotFound, "")
	})
	t.Run("items_cursor_forgery tampered HMAC is 400", func(t *testing.T) {
		enc, sig, _ := strings.Cut(firstCursor, ".")
		body, _ := base64.RawURLEncoding.DecodeString(enc)
		var p map[string]any
		_ = json.Unmarshal(body, &p)
		p["a"] = 0
		edited, _ := json.Marshal(p)
		for _, bad := range []string{
			base64.RawURLEncoding.EncodeToString(edited) + "." + sig,
			enc + ".AAAA" + sig[4:],
			"not-a-cursor",
		} {
			assertProblem(t, get(base+"?port=main&cursor="+url.QueryEscape(bad), "ops"), http.StatusBadRequest, "cursor-invalid", "")
		}
	})
	t.Run("items_cursor_cross_run cursor bound to another step or port is 400", func(t *testing.T) {
		exec2 := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
		d2 := fetchExecutionDetail(t, h, admin, tenant, ws, exec2.ID)
		other := "/api/v1/executions/" + exec2.ID + "/steps/" + d2.Steps[0].ID + "/items?port=main&cursor=" + url.QueryEscape(firstCursor)
		assertProblem(t, get(other, "ops"), http.StatusBadRequest, "cursor-invalid", "")
		assertProblem(t, get(base+"?port=result&cursor="+url.QueryEscape(firstCursor), "ops"), http.StatusBadRequest, "cursor-invalid", "")
	})
	t.Run("items_cursor_no_workspace_id", func(t *testing.T) {
		enc, _, _ := strings.Cut(firstCursor, ".")
		body, _ := base64.RawURLEncoding.DecodeString(enc)
		if strings.Contains(string(body), ws.ID) || strings.Contains(strings.ToLower(string(body)), "workspace") {
			t.Fatal("cursor carries a workspace id")
		}
		// A valid cursor replayed from another workspace still gets 404, never rows.
		assertProblem(t, get(base+"?port=main&cursor="+url.QueryEscape(firstCursor), "other"), http.StatusNotFound, CodeNotFound, "")
	})
	t.Run("expired and unknown-kid cursors are 400", func(t *testing.T) {
		stranger := itemcursor.NewRandom()
		foreign, _ := stranger.Sign(itemcursor.Binding{ExecutionID: exec.ID, StepID: stepID, Port: "main"}, 10, clock())
		assertProblem(t, get(base+"?port=main&cursor="+url.QueryEscape(foreign), "ops"), http.StatusBadRequest, "cursor-invalid", "")
		frozen.Add(int64(itemcursor.TTL + time.Second))
		assertProblem(t, get(base+"?port=main&cursor="+url.QueryEscape(firstCursor), "ops"), http.StatusBadRequest, "cursor-invalid", "")
	})
	t.Run("port is required and limit must be positive", func(t *testing.T) {
		assertProblem(t, get(base, "ops"), http.StatusBadRequest, CodeInvalidRequest, "")
		assertProblem(t, get(base+"?port=main&limit=0", "ops"), http.StatusBadRequest, CodeInvalidRequest, "")
	})
	t.Run("single_item_backcompat through the API", func(t *testing.T) {
		p := decode(get(base+"?port=nothing", "ops"))
		if p.Total != 0 || len(p.Items) != 0 {
			t.Fatalf("page = %+v", p)
		}
	})
	t.Run("items_endpoint_rate_limited per principal", func(t *testing.T) {
		frozen.Add(int64(2 * time.Minute))
		limited := false
		for i := 0; i < 200; i++ {
			rec := get(base+"?port=main&limit=1", "ops")
			if rec.Code == http.StatusTooManyRequests {
				limited = true
				break
			}
		}
		if !limited {
			t.Fatal("never rate limited")
		}
	})
}

func TestStepItemsFailsClosedWithoutCursorKey(t *testing.T) {
	t.Setenv(itemcursor.EnvSecret, "")
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	api, ok := h.(*API)
	if !ok {
		t.Skip("handler is not *API")
	}
	api.srv.ItemsCursor = nil
	created := createWorkflow(t, h, admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, h, admin, tenant, ws, created.Workflow.ID, created.Draft.Revision, "nokey")
	exec := startExecution(t, h, admin, tenant, ws, created.Workflow.ID, pub.Version.ID)
	detail := fetchExecutionDetail(t, h, admin, tenant, ws, exec.ID)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, workspaceRequest(http.MethodGet, "/api/v1/executions/"+exec.ID+"/steps/"+detail.Steps[0].ID+"/items?port=main", nil, admin, tenant, ws))
	assertProblem(t, rec, http.StatusServiceUnavailable, "dependency-unavailable", "")
}
