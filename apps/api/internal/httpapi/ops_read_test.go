package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

var opsReadPaths = []string{
	"/api/v1/metrics",
	"/api/v1/openapi.yaml",
	"/api/v1/openapi.json",
	"/api/v1/swagger",
}

func opsReadDeps(store identity.Store, sessions session.Store, admins []authz.PrincipalRef, trustHeaders bool) Deps {
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
		PlatformAdmins: admins,
		Security:       Security{TrustIdentityHeaders: trustHeaders},
	}
}

func TestOpsReadUnauthenticatedIs401(t *testing.T) {
	h := New(nil)
	for _, path := range opsReadPaths {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	}
}

func TestOpsReadHealthAndReadinessStayOpen(t *testing.T) {
	h := New(ReadyChecker(func(context.Context) error { return nil }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d", rec.Code)
	}
	assertJSONStatus(t, rec.Body.Bytes(), "ok")

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readiness", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("readiness status = %d body=%s", rec.Code, rec.Body.String())
	}
	assertJSONStatus(t, rec.Body.Bytes(), "ready")
}

func TestOpsReadAuthorizedSessionCookie(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(opsReadDeps(store, sessions, admins, false))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "ops-1", "Ops")

	for _, path := range opsReadPaths {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, path, "", issued.Token, issued.CSRF)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s cookie status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestOpsReadAuthorizedBearer(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(opsReadDeps(store, sessions, admins, false))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "ops-1", "Ops")

	for _, path := range opsReadPaths {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer "+issued.Token)
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s bearer status = %d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "Bearer not-a-session")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
}

func TestOpsReadAuthorizedTrustedDevHeaders(t *testing.T) {
	store := identity.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(opsReadDeps(store, nil, admins, true))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set(headerIssuer, "https://idp.example")
	req.Header.Set(headerSubject, "ops-1")
	req.Header.Set(headerDisplayName, "Ops")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "flowforge_http_requests_total") {
		t.Fatalf("missing metrics: %s", rec.Body.String())
	}
}

func TestOpsReadNonAdminIs403(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(opsReadDeps(store, sessions, admins, false))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "rando-1", "Rando")

	for _, path := range opsReadPaths {
		rec := httptest.NewRecorder()
		req := sessionAPIRequest(http.MethodGet, path, "", issued.Token, issued.CSRF)
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
	}
}

func TestOpsReadEmptyPlatformAdminsIs403(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(opsReadDeps(store, sessions, []authz.PrincipalRef{}, false))
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "ops-1", "Ops")

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/metrics", "", issued.Token, issued.CSRF)
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
}

func TestOpsReadFailClosedRejectsIdentityHeaders(t *testing.T) {
	store := identity.NewMemory()
	admins := []authz.PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	h := NewWithDeps(opsReadDeps(store, nil, admins, false))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/swagger", nil)
	req.Header.Set(headerIssuer, "https://idp.example")
	req.Header.Set(headerSubject, "ops-1")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
}
