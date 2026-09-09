package httpapi

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"log/slog"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

type sessionEnv struct {
	h     http.Handler
	store *identity.Memory
	now   *time.Time
}

func newSessionEnv(sec Security) sessionEnv {
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	store := identity.NewMemory()
	clock := &now
	if sec.Session.IdleTimeout == 0 {
		sec.Session.IdleTimeout = 30 * time.Minute
	}
	if sec.Session.AbsoluteTimeout == 0 {
		sec.Session.AbsoluteTimeout = 12 * time.Hour
	}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: sec,
		Now:      func() time.Time { return *clock },
	}))
	return sessionEnv{h: h, store: store, now: clock}
}

func (e sessionEnv) advance(d time.Duration) {
	*e.now = e.now.Add(d)
}

func TestSessionCreateIssuesSecureCookies(t *testing.T) {
	env := newSessionEnv(Security{})
	rec, payload := createSession(t, env.h, "https://idp.example", "admin-1", "Admin", false)
	assertSessionCookies(t, rec, false)
	if payload.CSRFToken == "" || payload.Principal.ID == "" {
		t.Fatalf("missing csrf or principal: %+v", payload)
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("CSP must be set on session responses")
	}

	https := httptest.NewRecorder()
	req := sessionCreateRequest("https://idp.example", "admin-2", "Admin")
	req.TLS = &tls.ConnectionState{}
	env.h.ServeHTTP(https, req)
	if https.Code != http.StatusCreated {
		t.Fatalf("https create: %d %s", https.Code, https.Body.String())
	}
	assertSessionCookies(t, https, true)
}

func TestSessionCreateAcceptsIdentityHeaders(t *testing.T) {
	env := newSessionEnv(Security{})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/session", nil)
	req.Header.Set(headerIssuer, "https://idp.example")
	req.Header.Set(headerSubject, "hook-user")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestSessionCreateBodyCannotOverrideIdentityHeaders(t *testing.T) {
	env := newSessionEnv(Security{})
	rec := httptest.NewRecorder()
	req := sessionCreateRequest("https://idp.example", "attacker-as-admin", "Admin")
	req.Header.Set(headerIssuer, "https://idp.example")
	req.Header.Set(headerSubject, "real-user")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if rec.Result().Cookies() != nil {
		for _, c := range rec.Result().Cookies() {
			if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
				t.Fatal("must not issue a session when body identity conflicts with headers")
			}
		}
	}

	rec = httptest.NewRecorder()
	req = sessionCreateRequest("https://idp.example", "real-user", "Real")
	req.Header.Set(headerIssuer, "https://idp.example")
	req.Header.Set(headerSubject, "real-user")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("matching body+headers: %d %s", rec.Code, rec.Body.String())
	}
}

func TestHeaderAuthStillWorksWithoutSession(t *testing.T) {
	env := newSessionEnv(Security{})
	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/permission-matrix", nil)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("header auth: %d %s", rec.Code, rec.Body.String())
	}
}

func TestCSRFFailClosedOnStateChangingRequests(t *testing.T) {
	env := newSessionEnv(Security{})
	created, payload := createSession(t, env.h, "https://idp.example", "admin-1", "Admin", false)
	token, csrf := sessionPair(t, created)
	seedTenantWorkspace(t, env.h, "https://idp.example", "admin-1")

	t.Run("missing csrf", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"nope","name":"Nope"}`, token, "")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("wrong csrf header", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"nope","name":"Nope"}`, token, csrf)
		req.Header.Set(session.CSRFHeader, "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("header and cookie mismatch", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"nope","name":"Nope"}`, token, csrf)
		req.Header.Del("Cookie")
		req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
		req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"})
		req.Header.Set(session.CSRFHeader, csrf)
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("valid csrf succeeds", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf)
		env.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("get session: %d %s", rec.Code, rec.Body.String())
		}
		if !strings.Contains(rec.Body.String(), payload.Session.ID) {
			t.Fatalf("missing session id: %s", rec.Body.String())
		}
	})

	t.Run("logout without csrf fails", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodPost, "/api/v1/session/logout", "", token, "")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})
}

func TestHeaderAuthSkipsCSRF(t *testing.T) {
	env := newSessionEnv(Security{})
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, identity.User{
		Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin",
	})
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("header auth post: %d %s", rec.Code, rec.Body.String())
	}
}

func TestHostileOriginFailsClosed(t *testing.T) {
	env := newSessionEnv(Security{AllowedOrigins: []string{"https://app.example"}})

	t.Run("create from hostile origin", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionCreateRequest("https://idp.example", "admin-1", "Admin")
		req.Header.Set("Origin", "https://evil.example")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("hostile origin must not receive ACAO")
		}
	})

	t.Run("preflight from hostile origin", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodOptions, "/api/v1/session", nil)
		req.Header.Set("Origin", "https://evil.example")
		req.Header.Set("Access-Control-Request-Method", "POST")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
		if rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("hostile preflight must not receive ACAO")
		}
	})

	t.Run("null origin", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionCreateRequest("https://idp.example", "admin-1", "Admin")
		req.Header.Set("Origin", "null")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("allowlisted origin receives credentialed CORS", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionCreateRequest("https://idp.example", "admin-1", "Admin")
		req.Header.Set("Origin", "https://app.example")
		env.h.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("allowlisted create: %d %s", rec.Code, rec.Body.String())
		}
		if rec.Header().Get("Access-Control-Allow-Origin") != "https://app.example" {
			t.Fatalf("ACAO = %q", rec.Header().Get("Access-Control-Allow-Origin"))
		}
		if rec.Header().Get("Access-Control-Allow-Credentials") != "true" {
			t.Fatal("credentialed CORS required")
		}
		if rec.Header().Get("Access-Control-Allow-Origin") == "*" {
			t.Fatal("wildcard credentialed CORS is prohibited")
		}
	})

	t.Run("session cookie from hostile origin", func(t *testing.T) {
		created, _ := createSession(t, env.h, "https://idp.example", "admin-1", "Admin", false)
		token, csrf := sessionPair(t, created)
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf)
		req.Header.Set("Origin", "https://evil.example")
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})
}

func TestStaleSessionFailsClosed(t *testing.T) {
	env := newSessionEnv(Security{Session: SessionPolicy{IdleTimeout: time.Minute, AbsoluteTimeout: 2 * time.Hour}})
	created, _ := createSession(t, env.h, "https://idp.example", "admin-1", "Admin", false)
	token, csrf := sessionPair(t, created)

	env.advance(61 * time.Second)
	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/session/refresh", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestRefreshExtendsIdleButNotAbsolute(t *testing.T) {
	env := newSessionEnv(Security{Session: SessionPolicy{IdleTimeout: time.Hour, AbsoluteTimeout: 3 * time.Hour}})
	created, first := createSession(t, env.h, "https://idp.example", "admin-1", "Admin", false)
	token, csrf := sessionPair(t, created)

	env.advance(50 * time.Minute)
	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/session/refresh", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", rec.Code, rec.Body.String())
	}
	var refreshed sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &refreshed); err != nil {
		t.Fatal(err)
	}
	if !refreshed.Session.IdleExpiresAt.After(first.Session.IdleExpiresAt) {
		t.Fatal("idle expiry should extend")
	}
	if !refreshed.Session.AbsoluteExpiresAt.Equal(first.Session.AbsoluteExpiresAt) {
		t.Fatal("absolute expiry is a hard cap")
	}
	token, csrf = sessionPair(t, rec)

	env.advance(3 * time.Hour)
	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestPrivilegeEscalationFailsClosed(t *testing.T) {
	env := newSessionEnv(Security{})
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	seedTenantWorkspace(t, env.h, admin.Issuer, admin.ExternalSubject)

	ws, tenant := currentWorkspace(t, env.h, admin)
	viewer := putMember(t, env.h, admin, tenant, ws, `{"issuer":"https://idp.example","external_subject":"viewer-1","display_name":"Viewer","role_keys":["viewer"]}`)

	created, _ := createSession(t, env.h, viewer.User.Issuer, viewer.User.ExternalSubject, viewer.User.DisplayName, false)
	token, csrf := sessionPair(t, created)

	t.Run("viewer session cannot administer", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, "/api/v1/workspace/members", "", token, csrf)
		req.Header.Set(headerTenantID, tenant.ID)
		req.Header.Set(headerTenantSlug, tenant.Slug)
		req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("viewer session cannot adopt admin headers", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, "/api/v1/workspace/members", "", token, csrf)
		req.Header.Set(headerIssuer, admin.Issuer)
		req.Header.Set(headerSubject, admin.ExternalSubject)
		req.Header.Set(headerTenantID, tenant.ID)
		req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	})

	t.Run("forged session cookie", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, "/api/v1/session", "", strings.Repeat("ab", 32), csrf)
		env.h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	})
}

func TestLogoutRevokesSession(t *testing.T) {
	env := newSessionEnv(Security{})
	created, _ := createSession(t, env.h, "https://idp.example", "admin-1", "Admin", false)
	token, csrf := sessionPair(t, created)

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/session/logout", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestSessionAuditIsSecretFree(t *testing.T) {
	var buf bytes.Buffer
	now := time.Date(2026, 9, 8, 12, 0, 0, 0, time.UTC)
	clock := &now
	store := identity.NewMemory()
	sessions := session.NewMemory()
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:    store,
		Sessions: sessions,
		Log:      log,
		Now:      func() time.Time { return *clock },
	}))
	created, payload := createSession(t, h, "https://idp.example", "admin-1", "Admin", false)
	token, csrf := sessionPair(t, created)

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/session/audit-events", "", token, csrf)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("audit: %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, session.EventCreated) {
		t.Fatalf("missing created event: %s", body)
	}
	if strings.Contains(body, token) || strings.Contains(body, csrf) {
		t.Fatal("audit leaked cookie secrets")
	}
	logs := buf.String()
	if strings.Contains(logs, token) || strings.Contains(logs, csrf) {
		t.Fatalf("logs leaked cookie secrets: %s", logs)
	}
	if payload.Session.ID != "" && !strings.Contains(logs, payload.Session.ID) {
		t.Fatalf("logs should include session id: %s", logs)
	}
}

func TestGetSessionRequiresCookie(t *testing.T) {
	env := newSessionEnv(Security{})
	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/session", nil)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func createSession(t *testing.T, h http.Handler, issuer, subject, display string, https bool) (*httptest.ResponseRecorder, sessionResponse) {
	t.Helper()
	rec := httptest.NewRecorder()
	req := sessionCreateRequest(issuer, subject, display)
	if https {
		req.TLS = &tls.ConnectionState{}
	}
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create session: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	return rec, payload
}

func sessionCreateRequest(issuer, subject, display string) *http.Request {
	body := `{"issuer":"` + issuer + `","external_subject":"` + subject + `","display_name":"` + display + `"}`
	req := httptest.NewRequest(http.MethodPost, "/api/v1/session", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func sessionPair(t *testing.T, rec *httptest.ResponseRecorder) (token, csrf string) {
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
		t.Fatalf("missing session cookies: token=%q csrf=%q", token, csrf)
	}
	return token, csrf
}

func sessionAPIRequest(method, path, body, token, csrf string) *http.Request {
	var req *http.Request
	if body == "" {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	if csrf != "" {
		req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
		req.Header.Set(session.CSRFHeader, csrf)
	}
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func assertSessionCookies(t *testing.T, rec *httptest.ResponseRecorder, secure bool) {
	t.Helper()
	var sessionCookie, csrfCookie *http.Cookie
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case session.CookieName:
			sessionCookie = c
		case session.CSRFCookieName:
			csrfCookie = c
		}
	}
	if sessionCookie == nil || csrfCookie == nil {
		t.Fatal("expected ff_session and ff_csrf cookies")
	}
	if !sessionCookie.HttpOnly {
		t.Fatal("session cookie must be HttpOnly")
	}
	if csrfCookie.HttpOnly {
		t.Fatal("csrf cookie must be readable by the browser client")
	}
	if sessionCookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("session SameSite = %v", sessionCookie.SameSite)
	}
	if csrfCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("csrf SameSite = %v", csrfCookie.SameSite)
	}
	if sessionCookie.Path != session.CookiePath || csrfCookie.Path != session.CookiePath {
		t.Fatalf("cookie path session=%q csrf=%q", sessionCookie.Path, csrfCookie.Path)
	}
	if sessionCookie.Secure != secure || csrfCookie.Secure != secure {
		t.Fatalf("Secure session=%v csrf=%v want %v", sessionCookie.Secure, csrfCookie.Secure, secure)
	}
}

func seedTenantWorkspace(t *testing.T, h http.Handler, issuer, subject string) {
	t.Helper()
	admin := identity.User{Issuer: issuer, ExternalSubject: subject, DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusConflict {
		t.Fatalf("seed tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusConflict {
		t.Fatalf("seed workspace: %d %s", rec.Code, rec.Body.String())
	}
}
