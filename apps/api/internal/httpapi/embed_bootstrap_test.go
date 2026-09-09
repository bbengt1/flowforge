package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestEmbedSessionCannotCreateTenant(t *testing.T) {
	env := newEmbedEnv(t)
	token, csrf := exchangeEmbedSession(t, env, env.ops, []string{authz.PermWorkflowView})

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"evil","name":"Evil"}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if !strings.Contains(rec.Body.String(), "cannot create tenants or workspaces") {
		t.Fatalf("detail should mention embed bootstrap deny: %s", rec.Body.String())
	}
	if _, err := env.store.GetTenantBySlug(t.Context(), "evil"); err == nil {
		t.Fatal("embed session must not create a tenant")
	}
}

func TestEmbedSessionCannotCreateWorkspace(t *testing.T) {
	env := newEmbedEnv(t)
	token, csrf := exchangeEmbedSession(t, env, env.ops, []string{authz.PermWorkflowView})

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"sibling","name":"Sibling"}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if !strings.Contains(rec.Body.String(), "cannot create tenants or workspaces") {
		t.Fatalf("detail should mention embed bootstrap deny: %s", rec.Body.String())
	}
	if _, _, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "sibling"); err == nil {
		t.Fatal("embed session must not create a sibling workbench")
	}
}

func TestEmbedSessionCannotCreateSiblingWorkbenchUnderOtherTenant(t *testing.T) {
	env := newEmbedEnv(t)
	otherAdmin := identity.User{Issuer: "https://idp.example", ExternalSubject: "other-admin", DisplayName: "Other"}
	seedWorkspace(t, env.store, otherAdmin, "other", "ops", "Other")

	token, csrf := exchangeEmbedSession(t, env, env.ops, []string{authz.PermWorkspaceAdminister})
	other, err := env.store.GetTenantBySlug(t.Context(), "other")
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	body := `{"tenant_id":"` + other.ID + `","workbench_key":"takeover","name":"Takeover"}`
	req := sessionAPIRequest(http.MethodPost, "/api/v1/workspaces", body, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if _, _, err := env.store.ResolveWorkspace(t.Context(), other.ID, "", "takeover"); err == nil {
		t.Fatal("embed session must not create a workbench under another tenant")
	}
}

func TestPortalNonMemberAdminCannotBootstrapMembership(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := &now
	keys := embed.TestMaterial()
	store := identity.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:         store,
		Sessions:      session.NewMemory(),
		EmbedKeys:     keys,
		EmbedJTI:      embed.NewMemoryJTI(),
		PortalIssuers: []string{portalIssuer},
		PlatformAdmins: []authz.PrincipalRef{
			{Issuer: portalIssuer, Subject: "portal-guest"},
		},
		Now: func() time.Time { return *clock },
	}))
	admin := identity.User{Issuer: portalIssuer, ExternalSubject: "portal-svc", DisplayName: "Portal"}
	seedWorkspace(t, store, admin, "acme", "ops", "Ops")
	env := portalEnv{embedEnv: embedEnv{h: h, store: store, keys: keys, now: clock, admin: admin}}

	rec := env.mintPortal(t, `{"portalRoles":["portal.admin"],"subject":"portal-guest"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if contains(minted.Capabilities, authz.PermPlatformAdminister) {
		t.Fatal("portal.admin must not mint platform.administer")
	}

	ex := env.exchange(t, minted.Assertion)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange %d %s", ex.Code, ex.Body.String())
	}
	token, csrf := sessionCookies(t, ex)

	guest, err := env.store.ResolveUserRef(t.Context(), "", portalIssuer, "portal-guest", "")
	if err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"/api/v1/tenants", "/api/v1/workspaces"} {
		body := `{"slug":"guest-tenant","name":"Guest"}`
		if path == "/api/v1/workspaces" {
			body = `{"tenant_slug":"acme","workbench_key":"guest-bench","name":"Guest"}`
		}
		denied := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodPost, path, body, token, csrf)
		env.h.ServeHTTP(denied, req)
		assertProblem(t, denied, http.StatusForbidden, CodeForbidden, "")
		if !strings.Contains(denied.Body.String(), "cannot create tenants or workspaces") {
			t.Fatalf("%s detail: %s", path, denied.Body.String())
		}
	}
	if _, err := env.store.GetTenantBySlug(t.Context(), "guest-tenant"); err == nil {
		t.Fatal("portal non-member must not create a tenant")
	}
	if _, _, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "guest-bench"); err == nil {
		t.Fatal("portal non-member must not create a sibling workbench")
	}
	items, err := env.store.ListWorkspacesForUser(t.Context(), guest.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("portal non-member became a workspace member: %+v", items)
	}
}

func TestPortalAdminCapabilityCannotMintPlatformAdminister(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["portal.admin"],"capabilities":["platform.administer"]}`)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
	if !strings.Contains(rec.Body.String(), "platform.administer") {
		t.Fatalf("detail should mention platform.administer: %s", rec.Body.String())
	}
}

func TestPlatformAdminNonEmbedCanStillBootstrap(t *testing.T) {
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

func TestEmbedSessionOfPlatformAdminStillCannotBootstrap(t *testing.T) {
	env := newEmbedEnv(t)
	token, csrf := exchangeEmbedSession(t, env, env.ops, []string{authz.PermWorkflowView})

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"from-embed","name":"From Embed"}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"from-embed","name":"From Embed"}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintRejectsPlatformAdministerCapability(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["platform.administer"]}`)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusBadRequest {
		t.Fatalf("mint platform.administer: %d %s", rec.Code, rec.Body.String())
	}
}

func exchangeEmbedSession(t *testing.T, env embedEnv, subject identity.User, caps []string) (token, csrf string) {
	t.Helper()
	ws, tenant, err := env.store.ResolveWorkspace(t.Context(), "", "acme", "ops")
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
		t.Fatalf("exchange: %d %s", ex.Code, ex.Body.String())
	}
	return sessionCookies(t, ex)
}

func sessionCookies(t *testing.T, rec *httptest.ResponseRecorder) (token, csrf string) {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case session.CookieName:
			token = c.Value
		case session.CSRFCookieName:
			csrf = c.Value
		}
	}
	if token == "" || csrf == "" {
		t.Fatal("missing ff_session / ff_csrf")
	}
	return token, csrf
}
