package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

type lookupErrorStore struct {
	*identity.Memory
	err error
}

func (s lookupErrorStore) LookupLocalLogin(_ context.Context, _ string) (identity.LocalLogin, error) {
	return identity.LocalLogin{}, s.err
}

func newLoginEnv(t *testing.T) (*identity.Memory, http.Handler) {
	t.Helper()
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{}, // trusted-dev stays fail-closed
	})
	return store, h
}

func seedLocalLogin(t *testing.T, store *identity.Memory, issuer, subject, display, password string) identity.User {
	t.Helper()
	user, err := store.UpsertUser(t.Context(), issuer, subject, display)
	if err != nil {
		t.Fatal(err)
	}
	ident, err := localauth.NormalizeIdentifier(subject)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := localauth.HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), user.ID, ident, hash); err != nil {
		t.Fatal(err)
	}
	return user
}

func loginRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func TestLocalLoginMintsStandaloneSession(t *testing.T) {
	store, h := newLoginEnv(t)
	user := seedLocalLogin(t, store, "https://idp.example", "admin@example.com", "Operator", "correct-horse")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"Admin@Example.com","password":"correct-horse"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	assertSessionCookies(t, rec, false)
	if strings.Contains(rec.Body.String(), "correct-horse") {
		t.Fatal("login must not echo the password")
	}
	assertNoPasswordField(t, rec.Body.String())

	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.Embed != nil {
		t.Fatalf("login session must omit session.embed: %+v", payload.Session.Embed)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("operator-set password must not force change")
	}
	if payload.Principal.ID != user.ID || payload.Principal.ExternalSubject != "admin@example.com" {
		t.Fatalf("principal: %+v", payload.Principal)
	}
	if payload.CSRFToken == "" {
		t.Fatal("csrf_token required")
	}

	token, csrf := sessionPair(t, rec)
	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", get.Code, get.Body.String())
	}
	var current sessionResponse
	if err := json.Unmarshal(get.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if current.Session.Embed != nil {
		t.Fatalf("GET /session after login must be non-embed: %+v", current.Session.Embed)
	}
	if strings.Contains(get.Body.String(), `"embed"`) {
		t.Fatalf("standalone GET /session grew embed fields: %s", get.Body.String())
	}
}

func TestLocalLoginAcceptsUsernameAlias(t *testing.T) {
	store, h := newLoginEnv(t)
	seedLocalLogin(t, store, "https://idp.example", "operator", "Operator", "correct-horse")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"username":"operator","password":"correct-horse"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("username login: %d %s", rec.Code, rec.Body.String())
	}
	assertSessionCookies(t, rec, false)
}

func TestLocalLoginRejectsBadPasswordWithoutLeakingField(t *testing.T) {
	store, h := newLoginEnv(t)
	seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin-1","password":"wrong-password"}`))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	body := rec.Body.String()
	if strings.Contains(body, "wrong-password") || strings.Contains(body, "correct-horse") {
		t.Fatal("401 must not echo passwords")
	}
	if strings.Contains(strings.ToLower(body), "identifier") || strings.Contains(strings.ToLower(body), "username") {
		t.Fatalf("401 must not say which field failed: %s", body)
	}
	if !strings.Contains(body, invalidCredentialsDetail) {
		t.Fatalf("401 detail: %s", body)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("bad password must not mint ff_session")
		}
	}
}

func TestLocalLoginUnknownUserSame401(t *testing.T) {
	_, h := newLoginEnv(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"email":"missing@example.com","password":"correct-horse"}`))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if !strings.Contains(rec.Body.String(), invalidCredentialsDetail) {
		t.Fatalf("unknown user must use the same detail: %s", rec.Body.String())
	}
}

func TestLocalLoginDoesNotRewriteTrustedDev(t *testing.T) {
	store, h := newLoginEnv(t)
	seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionCreateRequest("https://idp.example", "admin-1", "Operator"))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("fail-closed POST /session must not mint cookies")
		}
	}
}

func TestLocalLoginMethodNotAllowed(t *testing.T) {
	_, h := newLoginEnv(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/login", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "caller-request-16")
}

func TestBootstrapPasswordThenLocalLogin(t *testing.T) {
	boot := bootstrap.NewMemory()
	if err := boot.SetStep(t.Context(), bootstrap.StepPersistence, true); err != nil {
		t.Fatal(err)
	}
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Bootstrap: boot,
		Store:     store,
		Sessions:  session.NewMemory(),
		Security:  Security{},
	})

	create := httptest.NewRecorder()
	h.ServeHTTP(create, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"ops@example.com","password":"correct-horse"}`))
	if create.Code != http.StatusCreated {
		t.Fatalf("bootstrap admin: %d %s", create.Code, create.Body.String())
	}
	if strings.Contains(create.Body.String(), "correct-horse") {
		t.Fatal("bootstrap must not echo password")
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"email":"ops@example.com","password":"correct-horse"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("login after bootstrap: %d %s", rec.Code, rec.Body.String())
	}
	assertSessionCookies(t, rec, false)
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.Embed != nil {
		t.Fatal("bootstrap login must mint a non-embed session")
	}
}

// Path-2: B.3 without localseed.Apply still create-or-binds local/default
// so POST /login + GET /workspaces shows a selectable workbench.
func TestBootstrapPath2LoginListsDefaultWorkbench(t *testing.T) {
	boot := bootstrap.NewMemory()
	if err := boot.SetStep(t.Context(), bootstrap.StepPersistence, true); err != nil {
		t.Fatal(err)
	}
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Bootstrap: boot,
		Store:     store,
		Sessions:  session.NewMemory(),
		Security:  Security{},
	})
	if _, err := store.GetTenantBySlug(t.Context(), localseed.TenantSlug); !errors.Is(err, identity.ErrNotFound) {
		t.Fatalf("path-2 must start without localseed tenant: %v", err)
	}

	secret := "correct-horse-path2"
	create := httptest.NewRecorder()
	h.ServeHTTP(create, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1","display_name":"Operator","password":"`+secret+`"}`))
	if create.Code != http.StatusCreated {
		t.Fatalf("B.3: %d %s", create.Code, create.Body.String())
	}
	if strings.Contains(create.Body.String(), secret) || strings.Contains(create.Body.String(), `"password"`) {
		t.Fatal("B.3 must not echo password")
	}

	user, err := store.UpsertUser(t.Context(), "https://idp.example", "admin-1", "Operator")
	if err != nil {
		t.Fatal(err)
	}
	memberships, err := store.ListWorkspacesForUser(t.Context(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 || memberships[0].Tenant.Slug != localseed.TenantSlug || memberships[0].Workspace.WorkbenchKey != localseed.WorkbenchKey {
		t.Fatalf("B.3 must create-or-bind local/default: %+v", memberships)
	}
	if !authz.Allows(memberships[0].Permissions, authz.PermWorkspaceAdminister) {
		t.Fatalf("first admin must be workspace admin: %+v", memberships[0].Roles)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin-1","password":"`+secret+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), secret) {
		t.Fatal("login must not echo password")
	}
	assertSessionCookies(t, rec, false)
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.Embed != nil {
		t.Fatalf("path-2 login must omit session.embed: %+v", payload.Session.Embed)
	}

	token, csrf := sessionPair(t, rec)
	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", get.Code, get.Body.String())
	}
	var current sessionResponse
	if err := json.Unmarshal(get.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if current.Session.Embed != nil {
		t.Fatalf("GET /session after path-2 login must be non-embed: %+v", current.Session.Embed)
	}

	listed := httptest.NewRecorder()
	h.ServeHTTP(listed, sessionAPIRequest(http.MethodGet, "/api/v1/workspaces", "", token, csrf))
	if listed.Code != http.StatusOK {
		t.Fatalf("GET /workspaces: %d %s", listed.Code, listed.Body.String())
	}
	var workspaces listResponse[identity.Membership]
	if err := json.Unmarshal(listed.Body.Bytes(), &workspaces); err != nil {
		t.Fatal(err)
	}
	if len(workspaces.Items) != 1 {
		t.Fatalf("selectable workbenches: %+v", workspaces.Items)
	}
	item := workspaces.Items[0]
	if item.Tenant.Slug != localseed.TenantSlug || item.Workspace.WorkbenchKey != localseed.WorkbenchKey {
		t.Fatalf("want local/default, got tenant=%q workbench=%q", item.Tenant.Slug, item.Workspace.WorkbenchKey)
	}
	if !authz.Allows(item.Permissions, authz.PermWorkflowEdit) && !authz.Allows(item.Permissions, authz.PermWorkspaceAdminister) {
		t.Fatalf("listed workbench must be usable, perms=%v", item.Permissions)
	}
}

func TestLocalLoginRequiresIdentifierAndPassword(t *testing.T) {
	_, h := newLoginEnv(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin-1"}`))
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
}

func TestLocalLoginRateLimitedOnBurst(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{},
		LoginLimits: localauth.Limits{
			Window:     time.Minute,
			PerIP:      2,
			Identifier: 100,
		},
	})
	seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")

	first := httptest.NewRecorder()
	h.ServeHTTP(first, loginRequest(`{"identifier":"admin-1","password":"wrong-password"}`))
	assertProblem(t, first, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	second := httptest.NewRecorder()
	h.ServeHTTP(second, loginRequest(`{"identifier":"admin-1","password":"wrong-password"}`))
	assertProblem(t, second, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	burst := httptest.NewRecorder()
	h.ServeHTTP(burst, loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`))
	prob := assertProblem(t, burst, http.StatusTooManyRequests, CodeRateLimited, "caller-request-16")
	if burst.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After")
	}
	if !strings.Contains(strings.ToLower(prob.Detail), "rate limit") {
		t.Fatalf("detail %q", prob.Detail)
	}
	if strings.Contains(burst.Body.String(), "correct-horse") || strings.Contains(burst.Body.String(), "wrong-password") {
		t.Fatal("429 must not echo passwords")
	}
	for _, c := range burst.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("rate-limited login must not mint ff_session")
		}
	}
}

func TestLocalLoginRateLimitIdentifierIndependentOfIP(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{},
		LoginLimits: localauth.Limits{
			Window:     time.Minute,
			PerIP:      100,
			Identifier: 1,
		},
	})
	seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")

	first := loginRequest(`{"identifier":"admin-1","password":"wrong-password"}`)
	first.RemoteAddr = "192.0.2.10:1"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, first)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	second := loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`)
	second.RemoteAddr = "192.0.2.20:1"
	burst := httptest.NewRecorder()
	h.ServeHTTP(burst, second)
	assertProblem(t, burst, http.StatusTooManyRequests, CodeRateLimited, "caller-request-16")
}

func TestLocalLoginLimiterNilFailsClosed(t *testing.T) {
	s := &Server{loginLimits: localauth.DefaultLimits()}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/login", nil)
	ok, _, err := s.allowLogin(req, "admin-1")
	if err != nil || ok {
		t.Fatal("nil login limiter must fail closed")
	}
}

func TestLocalLoginLookupFailureIsDependencyUnavailable(t *testing.T) {
	store := lookupErrorStore{Memory: identity.NewMemory(), err: errors.New("connection refused")}
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{},
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`))
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
	if strings.Contains(rec.Body.String(), "correct-horse") {
		t.Fatal("503 must not echo the password")
	}
	if strings.Contains(strings.ToLower(rec.Body.String()), "invalid credentials") {
		t.Fatal("store failure must not look like a credential miss")
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("store failure must not mint ff_session")
		}
	}
}
