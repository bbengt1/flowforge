package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func assertNoPasswordField(t *testing.T, body string) {
	t.Helper()
	if strings.Contains(body, `"password"`) || strings.Contains(body, `"password_hash"`) {
		t.Fatalf("response must not include a password field: %s", body)
	}
	if strings.Contains(body, "$2a$") || strings.Contains(body, "$2b$") {
		t.Fatal("response must not include a bcrypt hash")
	}
}

func TestBootstrapLoginFirstSignInForcesChange(t *testing.T) {
	store, h := newLoginEnv(t)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin","password":"admin"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("one-time login: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"password":`) {
		t.Fatal("login must not echo a password value")
	}
	assertNoPasswordField(t, rec.Body.String())
	assertSessionCookies(t, rec, false)

	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Session.MustChangePassword {
		t.Fatal("first one-time sign-in must set must_change_password")
	}
	if payload.Session.Embed != nil {
		t.Fatal("login session must omit session.embed")
	}
	if payload.Principal.Issuer != localseed.BootstrapIssuer || payload.Principal.ExternalSubject != localseed.BootstrapSubject {
		t.Fatalf("principal %+v", payload.Principal)
	}

	token, csrf := sessionPair(t, rec)
	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", get.Code, get.Body.String())
	}
	assertNoPasswordField(t, get.Body.String())
	var current sessionResponse
	if err := json.Unmarshal(get.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if !current.Session.MustChangePassword {
		t.Fatal("GET /session must expose must_change_password for Chloe")
	}
}

func TestChangePasswordClearsFlagAndKillsOneTime(t *testing.T) {
	store, h := newLoginEnv(t)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"Admin","password":"admin"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)
	rotated := "correct-horse"

	change := httptest.NewRecorder()
	h.ServeHTTP(change, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"`+rotated+`"}`, token, csrf))
	if change.Code != http.StatusOK {
		t.Fatalf("change-password: %d %s", change.Code, change.Body.String())
	}
	if strings.Contains(change.Body.String(), rotated) {
		t.Fatal("change-password must not echo the new password")
	}
	assertNoPasswordField(t, change.Body.String())
	var after sessionResponse
	if err := json.Unmarshal(change.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if after.Session.MustChangePassword {
		t.Fatal("success must clear must_change_password")
	}

	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", get.Code, get.Body.String())
	}
	var current sessionResponse
	if err := json.Unmarshal(get.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if current.Session.MustChangePassword {
		t.Fatal("GET /session must stay cleared after change")
	}

	reuse := httptest.NewRecorder()
	h.ServeHTTP(reuse, loginRequest(`{"identifier":"admin","password":"admin"}`))
	assertProblem(t, reuse, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if !strings.Contains(reuse.Body.String(), invalidCredentialsDetail) {
		t.Fatalf("one-time reuse must be the same 401: %s", reuse.Body.String())
	}
	assertNoPasswordField(t, reuse.Body.String())
	for _, c := range reuse.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("dead one-time must not mint ff_session")
		}
	}

	next := httptest.NewRecorder()
	h.ServeHTTP(next, loginRequest(`{"identifier":"admin","password":"`+rotated+`"}`))
	if next.Code != http.StatusCreated {
		t.Fatalf("rotated login: %d %s", next.Code, next.Body.String())
	}
	var rotatedPayload sessionResponse
	if err := json.Unmarshal(next.Body.Bytes(), &rotatedPayload); err != nil {
		t.Fatal(err)
	}
	if rotatedPayload.Session.MustChangePassword {
		t.Fatal("rotated password must not require another change")
	}
}

func TestChangePasswordRejectsOneTimeAndReuse(t *testing.T) {
	store, h := newLoginEnv(t)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"admin"}`))
	token, csrf := sessionPair(t, login)

	oneTime := httptest.NewRecorder()
	h.ServeHTTP(oneTime, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"new_password":"admin"}`, token, csrf))
	assertProblem(t, oneTime, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if !strings.Contains(oneTime.Body.String(), changePasswordReuseDetail) {
		t.Fatalf("new==admin detail: %s", oneTime.Body.String())
	}
	assertNoPasswordField(t, oneTime.Body.String())

	reuse := httptest.NewRecorder()
	h.ServeHTTP(reuse, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"admin"}`, token, csrf))
	assertProblem(t, reuse, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	short := httptest.NewRecorder()
	h.ServeHTTP(short, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"short"}`, token, csrf))
	assertProblem(t, short, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if strings.Contains(short.Body.String(), "short") {
		t.Fatal("400 must not echo the rejected password")
	}

	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !cred.MustChangePassword || !localauth.Verify(localauth.OneTimePassword, cred.PasswordHash) {
		t.Fatal("rejected change must leave the one-time hash in place")
	}
}

func TestChangePasswordRequiresCSRF(t *testing.T) {
	store, h := newLoginEnv(t)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"admin"}`))
	token, _ := sessionPair(t, login)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"correct-horse"}`, token, ""))
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
}

func TestChangePasswordRejectsEmbedSession(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint: %d %s", rec.Code, rec.Body.String())
	}
	var minted struct {
		Assertion string `json:"assertion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
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
	assertNoPasswordField(t, ex.Body.String())
	var exchanged sessionResponse
	if err := json.Unmarshal(ex.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.Embed == nil {
		t.Fatal("exchange must stay embed-bound")
	}
	if exchanged.Session.MustChangePassword {
		t.Fatal("embed exchange must not set must_change_password")
	}

	token, csrf := sessionPair(t, ex)
	change := httptest.NewRecorder()
	env.h.ServeHTTP(change, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"correct-horse"}`, token, csrf))
	assertProblem(t, change, http.StatusForbidden, CodeForbidden, "caller-request-16")
}

func TestEnsureBootstrapLoginDoesNotOverwriteHTTP(t *testing.T) {
	store, h := newLoginEnv(t)
	user := seedLocalLogin(t, store, "https://idp.example", "ops@example.com", "Ops", "correct-horse")
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LookupLocalLogin(t.Context(), "admin"); err == nil {
		t.Fatal("seed must not invent admin when a local login exists")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"ops@example.com","password":"correct-horse"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("existing login: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("operator-set password must not force change")
	}
	if payload.Principal.ID != user.ID {
		t.Fatalf("principal %+v", payload.Principal)
	}
}

func TestTrustedDevSessionOmitsMustChangeClaim(t *testing.T) {
	store := identity.NewMemory()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{TrustIdentityHeaders: true},
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionCreateRequest("https://idp.example", "admin-1", "Operator"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("trusted-dev session: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("trusted-dev POST /session must not carry the local one-time claim")
	}
	if payload.Principal.ExternalSubject != "admin-1" {
		t.Fatalf("trusted-dev principal %+v", payload.Principal)
	}
}
