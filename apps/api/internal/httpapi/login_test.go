package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

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
	if strings.Contains(strings.ToLower(rec.Body.String()), "password") {
		t.Fatal("login must not include a password field")
	}

	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.Embed != nil {
		t.Fatalf("login session must omit session.embed: %+v", payload.Session.Embed)
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

func TestLocalLoginRequiresIdentifierAndPassword(t *testing.T) {
	_, h := newLoginEnv(t)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin-1"}`))
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
}
