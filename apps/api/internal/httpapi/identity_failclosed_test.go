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

func failClosedDeps(store identity.Store, sessions session.Store, admins []authz.PrincipalRef) Deps {
	if store == nil {
		store = identity.NewMemory()
	}
	if sessions == nil {
		sessions = session.NewMemory()
	}
	if admins == nil {
		admins = []authz.PrincipalRef{}
	}
	return Deps{
		Store:          store,
		Sessions:       sessions,
		Security:       Security{}, // TrustIdentityHeaders remains false
		PlatformAdmins: admins,
	}
}

func issueTestSession(t *testing.T, store identity.Store, sessions session.Store, issuer, subject, display string) (identity.User, session.Issued) {
	t.Helper()
	user, err := store.UpsertUser(t.Context(), issuer, subject, display)
	if err != nil {
		t.Fatal(err)
	}
	issued, err := sessions.Create(t.Context(), user.ID, time.Now().UTC(), 30*time.Minute, 12*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return user, issued
}

func TestFailClosedRejectsSelfAssertedIdentityHeaders(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(failClosedDeps(store, nil, nil))

	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/permission-matrix", nil)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	if store.HasPrincipal("https://idp.example", "admin-1") {
		t.Fatal("fail-closed header auth must not upsert a principal")
	}
}

func TestFailClosedSessionCreateDoesNotInventPrincipals(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(failClosedDeps(store, nil, nil))

	rec := httptest.NewRecorder()
	req := sessionCreateRequest("https://attacker.example", "minted-admin", "Attacker")
	req.Header.Set(headerIssuer, "https://attacker.example")
	req.Header.Set(headerSubject, "minted-admin")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("must not issue a session from self-asserted identity")
		}
	}
	if store.HasPrincipal("https://attacker.example", "minted-admin") {
		t.Fatal("POST /session must not invent a principal in fail-closed mode")
	}
}

func TestFailClosedUnauthenticatedBootstrapDenied(t *testing.T) {
	h := NewWithDeps(failClosedDeps(nil, nil, nil))

	for _, path := range []string{"/api/v1/tenants", "/api/v1/workspaces"} {
		rec := httptest.NewRecorder()
		body := `{"slug":"acme","name":"Acme"}`
		if path == "/api/v1/workspaces" {
			body = `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`
		}
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	}
}

func TestFailClosedHeaderBootstrapDenied(t *testing.T) {
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(failClosedDeps(nil, nil, admins))

	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, identity.User{
		Issuer: "https://idp.example", ExternalSubject: "ops-1", DisplayName: "Ops",
	})
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestFailClosedNonAdminSessionCannotBootstrap(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(failClosedDeps(store, sessions, admins))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "rando-1", "Rando")

	for _, path := range []string{"/api/v1/tenants", "/api/v1/workspaces"} {
		body := `{"slug":"nope","name":"Nope"}`
		if path == "/api/v1/workspaces" {
			body = `{"tenant_slug":"nope","workbench_key":"ops","name":"Ops"}`
		}
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodPost, path, body, issued.Token, issued.CSRF)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	}
}

func TestFailClosedEmptyPlatformAdminsDeniesBootstrap(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(failClosedDeps(store, sessions, []authz.PrincipalRef{}))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "ops-1", "Ops")

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, issued.Token, issued.CSRF)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestFailClosedPlatformAdminCanBootstrap(t *testing.T) {
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

func TestFailClosedTrustedDevStillRequiresPlatformAdmin(t *testing.T) {
	h := NewWithDeps(Deps{
		Store:          identity.NewMemory(),
		Sessions:       session.NewMemory(),
		Security:       Security{TrustIdentityHeaders: true},
		PlatformAdmins: []authz.PrincipalRef{},
	})
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, identity.User{
		Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin",
	})
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestFailClosedEmbedExchangeStillIssuesSession(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	keys := embed.TestMaterial()
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	seedWorkspace(t, store, admin, "acme", "ops", "Ops")
	ws, tenant, err := store.ResolveWorkspace(t.Context(), "", "acme", "ops")
	if err != nil {
		t.Fatal(err)
	}

	h := NewWithDeps(Deps{
		Store:          store,
		Sessions:       sessions,
		EmbedKeys:      keys,
		EmbedJTI:       embed.NewMemoryJTI(),
		Security:       Security{},
		PlatformAdmins: []authz.PrincipalRef{},
	})

	minted, _, err := embed.Mint(keys, embed.MintInput{
		Issuer:       admin.Issuer,
		Subject:      admin.ExternalSubject,
		Host:         admin.Issuer,
		TenantID:     tenant.ID,
		WorkbenchKey: ws.WorkbenchKey,
		WorkspaceID:  ws.ID,
		Capabilities: []string{authz.PermWorkflowView},
		Audience:     embed.DefaultAudience,
		Now:          time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	var exchanged embedExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.Embed == nil || exchanged.Session.Embed.WorkbenchKey != "ops" {
		t.Fatalf("session embed %+v", exchanged.Session.Embed)
	}
}

func TestFailClosedRotateStillRequiresPlatformAdmin(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	keys := embed.TestMaterial()
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	ops := identity.User{Issuer: "https://idp.example", ExternalSubject: "ops-1", DisplayName: "Ops"}
	seedWorkspace(t, store, admin, "acme", "ops", "Ops")
	_, adminSess := issueTestSession(t, store, sessions, admin.Issuer, admin.ExternalSubject, admin.DisplayName)
	_, opsSess := issueTestSession(t, store, sessions, ops.Issuer, ops.ExternalSubject, ops.DisplayName)

	h := NewWithDeps(Deps{
		Store:          store,
		Sessions:       sessions,
		EmbedKeys:      keys,
		EmbedJTI:       embed.NewMemoryJTI(),
		Security:       Security{},
		PlatformAdmins: []authz.PrincipalRef{{Issuer: ops.Issuer, Subject: ops.ExternalSubject}},
	})

	active := keys.PublicJWKS().Keys[0]
	body, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": active})
	if err != nil {
		t.Fatal(err)
	}

	denied := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/embed/keys/rotate", string(body), adminSess.Token, adminSess.CSRF)
	h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusForbidden, CodeForbidden, "")

	ok := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/embed/keys/rotate", string(body), opsSess.Token, opsSess.CSRF)
	h.ServeHTTP(ok, req)
	if ok.Code != http.StatusOK {
		t.Fatalf("platform-admin rotate: %d %s", ok.Code, ok.Body.String())
	}
}
