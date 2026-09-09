package httpapi

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func TestIdentityRequiresAuthentication(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/permission-matrix", nil))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestPermissionMatrixCoversRequiredFamilies(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/permission-matrix", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var payload permissionMatrixResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, p := range payload.Permissions {
		seen[p.Family] = true
	}
	for _, family := range authz.RequiredFamilies() {
		if !seen[family] {
			t.Fatalf("matrix missing family %s", family)
		}
	}
}

func TestHostSuppliedWorkspaceIDIsRejected(t *testing.T) {
	h, admin := seededWorkspace(t)

	t.Run("header workspace id without tenant workbench", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
		req.Header.Set(headerIssuer, admin.Issuer)
		req.Header.Set(headerSubject, admin.ExternalSubject)
		req.Header.Set(headerWorkspaceID, "11111111-1111-1111-1111-111111111111")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})

	t.Run("mismatched host workspace id", func(t *testing.T) {
		ws, tenant := currentWorkspace(t, h, admin)
		rec := httptest.NewRecorder()
		req := workspaceRequest(http.MethodGet, "/api/v1/workspace", nil, admin, tenant, ws)
		req.Header.Set(headerWorkspaceID, "22222222-2222-2222-2222-222222222222")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("create body workspace id", func(t *testing.T) {
		_, tenant := currentWorkspace(t, h, admin)
		rec := httptest.NewRecorder()
		body := `{"tenant_id":"` + tenant.ID + `","workbench_key":"other","name":"Other","workspace_id":"33333333-3333-3333-3333-333333333333"}`
		req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", body, admin)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	})
}

func TestDuplicateTenantWorkbenchIsConflict(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	rec := httptest.NewRecorder()
	body := `{"tenant_id":"` + tenant.ID + `","workbench_key":"` + ws.WorkbenchKey + `","name":"Duplicate"}`
	req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", body, admin)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
}

func TestMembershipAuthorizationDenyByDefault(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)

	viewer := putMember(t, h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"viewer-1","display_name":"Viewer","role_keys":["viewer"]}`)
	if !contains(viewer.Permissions, authz.PermWorkflowView) {
		t.Fatalf("viewer missing view: %v", viewer.Permissions)
	}
	for _, action := range []string{
		authz.PermWorkflowEdit, authz.PermWorkflowPublish, authz.PermWorkflowExecute,
		authz.PermCredentialManage, authz.PermApprovalDecide, authz.PermWorkspaceAdminister,
	} {
		if contains(viewer.Permissions, action) {
			t.Fatalf("viewer unexpectedly granted %s", action)
		}
	}

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workspace/members", nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workspace", nil, viewer.User, tenant, ws)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("viewer should read current workspace: %d %s", rec.Code, rec.Body.String())
	}
}

func TestCrossWorkspaceHostIdentityIsRejected(t *testing.T) {
	h, admin := seededWorkspace(t)
	wsA, tenant := currentWorkspace(t, h, admin)

	rec := httptest.NewRecorder()
	body := `{"tenant_id":"` + tenant.ID + `","workbench_key":"other-bench","name":"Other"}`
	req := identifiedJSON(http.MethodPost, "/api/v1/workspaces", body, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create second workspace: %d %s", rec.Code, rec.Body.String())
	}
	var wsB identity.Workspace
	if err := json.Unmarshal(rec.Body.Bytes(), &wsB); err != nil {
		t.Fatal(err)
	}

	outsider := putMember(t, h, admin, tenant, wsB, `{"issuer":"https://idp.example","external_subject":"outsider","role_keys":["admin"]}`)

	rec = httptest.NewRecorder()
	req = workspaceRequest(http.MethodGet, "/api/v1/workspace/members", nil, outsider.User, tenant, wsA)
	// Tenant+workbench resolve to A; caller is only a member of B.
	req.Header.Set(headerWorkbenchKey, wsA.WorkbenchKey)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestMatchingHostWorkspaceIDIsAllowedAfterServerResolution(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodGet, "/api/v1/workspace", nil, admin, tenant, ws)
	req.Header.Set(headerWorkspaceID, ws.ID)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestLastAdminCannotBeRemoved(t *testing.T) {
	h, admin := seededWorkspace(t)
	ws, tenant := currentWorkspace(t, h, admin)
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodDelete, "/api/v1/workspace/members/"+admin.ID, nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "")
}

func TestMethodNotAllowedOnIdentityRoutes(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/tenants", nil))
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "")
	if !strings.Contains(rec.Header().Get("Allow"), http.MethodPost) {
		t.Fatalf("Allow = %q", rec.Header().Get("Allow"))
	}
}

func seededWorkspace(t *testing.T) (http.Handler, identity.User) {
	t.Helper()
	store := identity.NewMemory()
	keys := vault.TestKeys()
	workflows := wfstore.NewMemory()
	ops := opsconfig.NewMemory()
	hooks := webhook.NewMemory()
	h := NewWithDeps(Deps{
		Store:     store,
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: workflows,
		Ops:       ops,
		Hooks:     hooks,
		Vault:     vault.NewMemory(keys, vault.CompositeRefFinder{workflows, ops, hooks}),
		Keys:      keys,
	})
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}

	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	var tenant identity.Tenant
	if err := json.Unmarshal(rec.Body.Bytes(), &tenant); err != nil {
		t.Fatal(err)
	}

	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("current workspace: %d %s", rec.Code, rec.Body.String())
	}
	var current currentWorkspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	return h, current.Principal
}

func currentWorkspace(t *testing.T, h http.Handler, user identity.User) (identity.Workspace, identity.Tenant) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set(headerIssuer, user.Issuer)
	req.Header.Set(headerSubject, user.ExternalSubject)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("current workspace: %d %s", rec.Code, rec.Body.String())
	}
	var payload currentWorkspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return payload.Workspace, payload.Tenant
}

func putMember(t *testing.T, h http.Handler, actor identity.User, tenant identity.Tenant, ws identity.Workspace, body string) identity.Member {
	t.Helper()
	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodPut, "/api/v1/workspace/members", strings.NewReader(body), actor, tenant, ws)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("put member: %d %s", rec.Code, rec.Body.String())
	}
	var m identity.Member
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func identifiedRequest(method, path string, body *strings.Reader) *http.Request {
	var r *http.Request
	if body == nil {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, body)
	}
	r.Header.Set(headerIssuer, "https://idp.example")
	r.Header.Set(headerSubject, "admin-1")
	r.Header.Set(headerDisplayName, "Admin")
	r.Header.Set(RequestIDHeader, "caller-request-16")
	return r
}

func identifiedJSON(method, path, body string, user identity.User) *http.Request {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerIssuer, user.Issuer)
	req.Header.Set(headerSubject, user.ExternalSubject)
	if user.DisplayName != "" {
		req.Header.Set(headerDisplayName, user.DisplayName)
	}
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func workspaceRequest(method, path string, body *strings.Reader, user identity.User, tenant identity.Tenant, ws identity.Workspace) *http.Request {
	var req *http.Request
	if body == nil {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, body)
	}
	req.Header.Set(headerIssuer, user.Issuer)
	req.Header.Set(headerSubject, user.ExternalSubject)
	req.Header.Set(headerTenantID, tenant.ID)
	req.Header.Set(headerTenantSlug, tenant.Slug)
	req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func contains(items []string, want string) bool {
	for _, item := range items {
		if item == want {
			return true
		}
	}
	return false
}
