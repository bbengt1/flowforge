package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestDeleteWorkspaceRevokesBoundEmbedSession(t *testing.T) {
	env := newEmbedEnv(t)
	token, csrf := exchangeEmbedForWorkbench(t, env, env.admin, "ops", []string{authz.PermWorkspaceAdminister, authz.PermWorkflowView})
	assertEmbedSessionCookies(t, token, csrf, env, true)

	ws, tenant, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "ops")
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodDelete, "/api/v1/workspace", "", token, csrf)
	req.Header.Set(headerTenantID, tenant.ID)
	req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}

	got, err := env.store.GetWorkspace(t.Context(), ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "disabled" {
		t.Fatalf("status %q", got.Status)
	}

	denied := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, "")
	env.h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestDeleteWorkspaceLeavesUnrelatedAndUnboundSessions(t *testing.T) {
	env := newEmbedEnv(t)
	otherAdmin := identity.User{Issuer: "https://idp.example", ExternalSubject: "other-admin", DisplayName: "Other"}
	seedWorkspace(t, env.store, otherAdmin, "acme", "other", "Other")

	bound, boundCSRF := exchangeEmbedForWorkbench(t, env, env.admin, "ops", []string{authz.PermWorkspaceAdminister, authz.PermWorkflowView})
	otherToken, otherCSRF := exchangeEmbedForWorkbench(t, env, env.admin, "other", []string{authz.PermWorkflowView})

	_, standalone := issueTestSession(t, env.store, env.sessions, env.admin.Issuer, env.admin.ExternalSubject, env.admin.DisplayName)

	ws, tenant, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "ops")
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodDelete, "/api/v1/workspace", "", bound, boundCSRF)
	req.Header.Set(headerTenantID, tenant.ID)
	req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}

	denied := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", bound, "")
	env.h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusUnauthorized, CodeUnauthenticated, "")

	alive := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", otherToken, "")
	env.h.ServeHTTP(alive, req)
	if alive.Code != http.StatusOK {
		t.Fatalf("other embed session: %d %s", alive.Code, alive.Body.String())
	}

	unbound := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", standalone.Token, "")
	env.h.ServeHTTP(unbound, req)
	if unbound.Code != http.StatusOK {
		t.Fatalf("unbound session: %d %s", unbound.Code, unbound.Body.String())
	}

	otherWS, otherTenant, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "other")
	if err != nil {
		t.Fatal(err)
	}
	if otherWS.Status != "active" {
		t.Fatalf("unrelated workspace status %q", otherWS.Status)
	}
	_ = otherCSRF
	_ = otherTenant
}

func TestDeleteWorkspaceViewerForbiddenDoesNotRevoke(t *testing.T) {
	env := newEmbedEnv(t)
	viewer := identity.User{Issuer: "https://idp.example", ExternalSubject: "viewer-1", DisplayName: "Viewer"}
	u, err := env.store.UpsertUser(t.Context(), viewer.Issuer, viewer.ExternalSubject, viewer.DisplayName)
	if err != nil {
		t.Fatal(err)
	}
	ws, tenant, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "ops")
	if err != nil {
		t.Fatal(err)
	}
	if err := env.store.SetMemberRoles(t.Context(), ws.ID, u.ID, []string{authz.RoleViewer}); err != nil {
		t.Fatal(err)
	}

	token, csrf := exchangeEmbedSession(t, env, viewer, []string{authz.PermWorkflowView})
	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodDelete, "/api/v1/workspace", "", token, csrf)
	req.Header.Set(headerTenantID, tenant.ID)
	req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	alive := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, "")
	env.h.ServeHTTP(alive, req)
	if alive.Code != http.StatusOK {
		t.Fatalf("viewer session: %d %s", alive.Code, alive.Body.String())
	}
	got, err := env.store.GetWorkspace(t.Context(), ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "active" {
		t.Fatalf("status %q", got.Status)
	}
}

func TestDeleteWorkspaceFailsClosedWhenSessionStoreMissing(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:    store,
		Sessions: nil,
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	seedWorkspace(t, store, admin, "acme", "ops", "Ops")
	ws, tenant, err := store.ResolveWorkspace(t.Context(), "", "acme", "ops")
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := workspaceRequest(http.MethodDelete, "/api/v1/workspace", nil, admin, tenant, ws)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "")
	got, err := store.GetWorkspace(t.Context(), ws.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "active" {
		t.Fatalf("must not delete when revoke cannot run: %q", got.Status)
	}
}

func TestDeleteWorkspaceDoesNotRegressPlatformAdminBootstrap(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(failClosedDeps(store, sessions, admins))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "ops-1", "Ops")

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, issued.Token, issued.CSRF)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("platform-admin tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, issued.Token, issued.CSRF)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("platform-admin workspace: %d %s", rec.Code, rec.Body.String())
	}
}

func exchangeEmbedForWorkbench(t *testing.T, env embedEnv, subject identity.User, workbench string, caps []string) (token, csrf string) {
	t.Helper()
	ws, tenant, err := env.store.ResolveWorkspace(t.Context(), "", "acme", workbench)
	if err != nil {
		t.Fatal(err)
	}
	minted, _, err := embed.Mint(env.keys, embed.MintInput{
		Issuer:       subject.Issuer,
		Subject:      subject.ExternalSubject,
		DisplayName:  subject.DisplayName,
		Host:         subject.Issuer,
		TenantID:     tenant.ID,
		WorkbenchKey: ws.WorkbenchKey,
		WorkspaceID:  ws.ID,
		Capabilities: caps,
		Audience:     embed.DefaultAudience,
		Now:          *env.now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ex := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"sdk":"embed.v1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(ex, req)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange %s: %d %s", workbench, ex.Code, ex.Body.String())
	}
	joined := strings.ToLower(strings.Join(ex.Header().Values("Set-Cookie"), "\n"))
	if !strings.Contains(joined, "samesite=none") || !strings.Contains(joined, "partitioned") {
		t.Fatalf("embed Set-Cookie must stay CHIPS: %v", ex.Header().Values("Set-Cookie"))
	}
	return sessionCookies(t, ex)
}

func assertEmbedSessionCookies(t *testing.T, token, csrf string, env embedEnv, _ bool) {
	t.Helper()
	if token == "" || csrf == "" {
		t.Fatal("missing embed session cookies")
	}
	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, "")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("embed session: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.Embed == nil || payload.Session.Embed.WorkbenchKey == "" {
		t.Fatalf("expected embed binding: %+v", payload.Session)
	}
}
