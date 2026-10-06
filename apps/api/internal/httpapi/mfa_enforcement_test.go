package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestMFAEnforcementDefaultStaysOn(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: sessions,
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  "https://idp.example",
			Subject: "admin-1",
		}},
	})
	user := seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")
	token, csrf := loginLocal(t, h, "admin-1", "correct-horse")

	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", token, csrf))
	assertProblem(t, denied, http.StatusForbidden, CodeMFARequired, "caller-request-16")

	status := getMFAStatus(t, h, token, csrf)
	if status.Enforcement != "on" || status.Enrolled || status.Satisfied || !status.Applicable {
		t.Fatalf("status = %+v", status)
	}
	if !slices.Equal(status.PrivilegedPermissions, authz.MFAPrivilegedPermissions()) {
		t.Fatalf("permissions = %v", status.PrivilegedPermissions)
	}
	if strings.Contains(mustBody(t, h, http.MethodGet, "/api/v1/session/mfa", "", token, csrf), "otpauth") {
		t.Fatal("status echoed an otpauth uri")
	}
	events := listUserAudit(t, sessions, user.ID)
	for _, event := range events {
		if event.MFABypassed || event.Reason == session.ReasonMFABypassed {
			t.Fatalf("default enforcement audited a bypass: %+v", event)
		}
	}
}

func TestMFAEnforcementOffSkipsStepUp(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: sessions,
		Security: Security{MFAEnforcementOff: true, TrustIdentityHeaders: true},
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  "https://idp.example",
			Subject: "admin-1",
		}},
	})
	user := seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")
	tenant, err := store.CreateTenant(t.Context(), "acme", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(t.Context(), tenant.ID, "default", "Default", user.ID)
	if err != nil {
		t.Fatal(err)
	}

	trusted := httptest.NewRecorder()
	h.ServeHTTP(trusted, sessionCreateRequest("https://idp.example", "admin-1", "Operator"))
	if trusted.Code != http.StatusCreated {
		t.Fatalf("trusted-dev: %d %s", trusted.Code, trusted.Body.String())
	}
	tToken, tCSRF := sessionPair(t, trusted)
	openapiTrusted := httptest.NewRecorder()
	h.ServeHTTP(openapiTrusted, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", tToken, tCSRF))
	if openapiTrusted.Code != http.StatusOK {
		t.Fatalf("trusted-dev openapi: %d %s", openapiTrusted.Code, openapiTrusted.Body.String())
	}
	if n := countBypass(listUserAudit(t, sessions, user.ID)); n != 0 {
		t.Fatalf("trusted-dev is not an MFA subject; bypass audits = %d", n)
	}

	token, csrf := loginLocal(t, h, "admin-1", "correct-horse")
	before := countBypass(listUserAudit(t, sessions, user.ID))
	allowed := httptest.NewRecorder()
	h.ServeHTTP(allowed, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", token, csrf))
	if allowed.Code != http.StatusOK {
		t.Fatalf("openapi with bypass: %d %s", allowed.Code, allowed.Body.String())
	}
	cred := httptest.NewRecorder()
	h.ServeHTTP(cred, credentialRequest(http.MethodGet, "/api/v1/credentials", token, csrf, tenant, ws))
	if cred.Code != http.StatusOK {
		t.Fatalf("credentials with bypass: %d %s", cred.Code, cred.Body.String())
	}
	sessionView := httptest.NewRecorder()
	h.ServeHTTP(sessionView, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if sessionView.Code != http.StatusOK {
		t.Fatalf("session: %d %s", sessionView.Code, sessionView.Body.String())
	}
	events := listUserAudit(t, sessions, user.ID)
	if got := countBypass(events); got != before+2 {
		t.Fatalf("bypass audits = %d want %d; events = %+v", got, before+2, events)
	}
	for _, event := range events {
		if !event.MFABypassed {
			continue
		}
		if event.Reason != session.ReasonMFABypassed || event.Outcome != session.OutcomeAllowed || !event.MFABypassed {
			t.Fatalf("bypass audit = %+v", event)
		}
		raw, err := json.Marshal(event)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(raw), `"mfa_bypassed":true`) {
			t.Fatalf("audit JSON = %s", raw)
		}
	}

	body := mustBody(t, h, http.MethodGet, "/api/v1/session/mfa", "", token, csrf)
	var status mfaStatus
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatal(err)
	}
	if status.Enforcement != "off" || status.Method != "totp" || status.Enrolled || status.Satisfied || !status.Applicable {
		t.Fatalf("status = %+v", status)
	}
	if !slices.Equal(status.PrivilegedPermissions, authz.MFAPrivilegedPermissions()) {
		t.Fatalf("permissions = %v", status.PrivilegedPermissions)
	}
	if strings.Contains(body, "otpauth") || strings.Contains(body, "correct-horse") {
		t.Fatal("mfa status echoed secret material")
	}

	enroll := httptest.NewRecorder()
	h.ServeHTTP(enroll, sessionAPIRequest(http.MethodPost, "/api/v1/session/mfa/enroll", "{}", token, csrf))
	assertProblem(t, enroll, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")

	viewer := seedLocalLogin(t, store, "https://idp.example", "viewer-1", "Viewer", "correct-horse")
	vToken, vCSRF := loginLocal(t, h, "viewer-1", "correct-horse")
	forbidden := httptest.NewRecorder()
	h.ServeHTTP(forbidden, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", vToken, vCSRF))
	assertProblem(t, forbidden, http.StatusForbidden, CodeForbidden, "caller-request-16")
	if countBypass(listUserAudit(t, sessions, viewer.ID)) != 0 {
		t.Fatal("RBAC denial must not record mfa_bypassed")
	}

	if err := store.RequireLocalPasswordChange(t.Context(), user.ID); err != nil {
		t.Fatal(err)
	}
	changedToken, changedCSRF := loginLocal(t, h, "admin-1", "correct-horse")
	blocked := httptest.NewRecorder()
	h.ServeHTTP(blocked, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", changedToken, changedCSRF))
	assertProblem(t, blocked, http.StatusForbidden, CodePasswordChangeRequired, "caller-request-16")

	ex := httptest.NewRecorder()
	exReq := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{}`))
	exReq.Header.Set("Content-Type", "application/json")
	exReq.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(ex, exReq)
	if ex.Code == http.StatusCreated || ex.Code == http.StatusNotFound {
		t.Fatalf("embed exchange changed: %d %s", ex.Code, ex.Body.String())
	}
}

func TestMFAEnforcementOffIgnoredWhenProductionLocked(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Store: store,
		Security: Security{
			MFAEnforcementOff: true,
			ProductionLocked:  true,
		},
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  "https://idp.example",
			Subject: "admin-1",
		}},
	})
	seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")
	token, csrf := loginLocal(t, h, "admin-1", "correct-horse")
	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", token, csrf))
	assertProblem(t, denied, http.StatusForbidden, CodeMFARequired, "caller-request-16")
	status := getMFAStatus(t, h, token, csrf)
	if status.Enforcement != "on" {
		t.Fatalf("locked process reported enforcement %q", status.Enforcement)
	}
}

func loginLocal(t *testing.T, h http.Handler, identifier, password string) (string, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"`+identifier+`","password":"`+password+`"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("login %s: %d %s", identifier, rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), password) {
		t.Fatal("login echoed the password")
	}
	return sessionPair(t, rec)
}

func getMFAStatus(t *testing.T, h http.Handler, token, csrf string) mfaStatus {
	t.Helper()
	body := mustBody(t, h, http.MethodGet, "/api/v1/session/mfa", "", token, csrf)
	var status mfaStatus
	if err := json.Unmarshal([]byte(body), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func mustBody(t *testing.T, h http.Handler, method, path, body, token, csrf string) string {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(method, path, body, token, csrf))
	if rec.Code != http.StatusOK {
		t.Fatalf("%s %s: %d %s", method, path, rec.Code, rec.Body.String())
	}
	return rec.Body.String()
}

func listUserAudit(t *testing.T, sessions session.Store, userID string) []session.AuditEvent {
	t.Helper()
	events, err := sessions.ListAudit(t.Context(), userID, 100)
	if err != nil {
		t.Fatal(err)
	}
	return events
}

func countBypass(events []session.AuditEvent) int {
	n := 0
	for _, event := range events {
		if event.MFABypassed {
			n++
		}
	}
	return n
}
