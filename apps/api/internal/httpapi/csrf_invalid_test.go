package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

// #636: both CSRF rejection paths answer 403 with problem code
// csrf-invalid and the same detail, and a role refusal stays forbidden.
func TestCSRFRejectionsUseCSRFInvalidCode(t *testing.T) {
	env := newSessionEnv(Security{})
	rec, _ := createSession(t, env.h, "https://idp.example", "csrf-user", "CSRF User", false)
	token, csrf := sessionPair(t, rec)

	const detail = "CSRF validation failed."
	check := func(name, method, path, body, header string) {
		t.Helper()
		req := sessionAPIRequest(method, path, body, token, csrf)
		if header == "" {
			req.Header.Del(session.CSRFHeader)
		} else {
			req.Header.Set(session.CSRFHeader, header)
		}
		out := httptest.NewRecorder()
		env.h.ServeHTTP(out, req)
		p := assertProblem(t, out, http.StatusForbidden, CodeCSRFInvalid, "caller-request-16")
		if p.Detail != detail || p.Title != "Forbidden" {
			t.Fatalf("%s: title=%q detail=%q", name, p.Title, p.Detail)
		}
	}
	// Path 1: the session-authenticated request check (any unsafe call).
	check("mismatch", http.MethodPost, "/api/v1/tenants", `{"slug":"csrf-a","name":"A"}`, "wrong")
	check("missing", http.MethodPost, "/api/v1/tenants", `{"slug":"csrf-a","name":"A"}`, "")
	// Path 2: logout.
	check("logout mismatch", http.MethodPost, "/api/v1/session/logout", "", "wrong")
	check("logout missing", http.MethodPost, "/api/v1/session/logout", "", "")

	// A failed logout CSRF check must not have revoked the session.
	out := httptest.NewRecorder()
	env.h.ServeHTTP(out, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if out.Code != http.StatusOK {
		t.Fatalf("session after rejected logout: %d %s", out.Code, out.Body.String())
	}

	// A valid token passing CSRF but refused by role is still forbidden.
	out = httptest.NewRecorder()
	env.h.ServeHTTP(out, sessionAPIRequest(http.MethodPost, "/api/v1/tenants", `{"slug":"csrf-b","name":"B"}`, token, csrf))
	if out.Code != http.StatusForbidden {
		t.Fatalf("role refusal status = %d %s", out.Code, out.Body.String())
	}
	assertProblem(t, out, http.StatusForbidden, CodeForbidden, "caller-request-16")
}
