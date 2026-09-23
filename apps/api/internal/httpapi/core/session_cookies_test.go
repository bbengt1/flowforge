package core

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestSessionCookieFlagsNeverWeakenCHIPS(t *testing.T) {
	chipsHTTP := sessionCookieFlags(false, true)
	if chipsHTTP.SameSite != http.SameSiteNoneMode || !chipsHTTP.Secure || !chipsHTTP.Partitioned {
		t.Fatalf("CHIPS on HTTP must still be None+Secure+Partitioned: %+v", chipsHTTP)
	}
	chipsHTTPS := sessionCookieFlags(true, true)
	if chipsHTTPS.SameSite != http.SameSiteNoneMode || !chipsHTTPS.Secure || !chipsHTTPS.Partitioned {
		t.Fatalf("CHIPS on HTTPS: %+v", chipsHTTPS)
	}
	csrf := csrfCookieFlags(false, true)
	if csrf.SameSite != http.SameSiteNoneMode || !csrf.Secure || !csrf.Partitioned {
		t.Fatalf("embed CSRF must be CHIPS, not Strict: %+v", csrf)
	}
}

func TestSessionCookieFlagsKeepFirstPartyDefaults(t *testing.T) {
	httpFirst := sessionCookieFlags(false, false)
	if httpFirst.SameSite != http.SameSiteLaxMode || httpFirst.Secure || httpFirst.Partitioned {
		t.Fatalf("HTTP first-party: %+v", httpFirst)
	}
	httpsFirst := sessionCookieFlags(true, false)
	if httpsFirst.SameSite != http.SameSiteLaxMode || !httpsFirst.Secure || httpsFirst.Partitioned {
		t.Fatalf("HTTPS first-party: %+v", httpsFirst)
	}
	csrfHTTP := csrfCookieFlags(false, false)
	if csrfHTTP.SameSite != http.SameSiteStrictMode || csrfHTTP.Secure || csrfHTTP.Partitioned {
		t.Fatalf("HTTP CSRF: %+v", csrfHTTP)
	}
	csrfHTTPS := csrfCookieFlags(true, false)
	if csrfHTTPS.SameSite != http.SameSiteStrictMode || !csrfHTTPS.Secure || csrfHTTPS.Partitioned {
		t.Fatalf("HTTPS CSRF: %+v", csrfHTTPS)
	}
}

func TestRequestCookieSecure(t *testing.T) {
	plain := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	if RequestCookieSecure(Security{}, plain) {
		t.Fatal("local HTTP must not force Secure")
	}
	if !RequestCookieSecure(Security{ProductionLocked: true}, plain) {
		t.Fatal("production-locked HTTP must set Secure")
	}
	if !RequestCookieSecure(Security{RequireTLS: true}, plain) {
		t.Fatal("REQUIRE_TLS must set Secure")
	}
	https := httptest.NewRequest(http.MethodGet, "/api/v1/session", nil)
	https.TLS = &tls.ConnectionState{}
	if !RequestCookieSecure(Security{}, https) {
		t.Fatal("HTTPS must set Secure")
	}
}

func TestWriteSessionCookiePairLocalHTTPOmitsSecure(t *testing.T) {
	got := httptest.NewRecorder()
	writeSessionCookiePair(got, "sess", "csrf", 60, false, false)
	assertRawFirstPartySetCookie(t, got, false)

	want := httptest.NewRecorder()
	for _, c := range []http.Cookie{
		{Name: session.CookieName, Value: "sess", Path: session.CookiePath, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 60},
		{Name: session.CSRFCookieName, Value: "csrf", Path: session.CookiePath, HttpOnly: false, SameSite: http.SameSiteStrictMode, MaxAge: 60},
	} {
		if v := c.String(); v != "" {
			want.Header().Add("Set-Cookie", v)
		}
	}
	if diff := cmpSetCookie(want, got); diff != "" {
		t.Fatal(diff)
	}
	raw := strings.ToLower(strings.Join(got.Header().Values("Set-Cookie"), "\n"))
	if strings.Contains(raw, "secure") {
		t.Fatalf("local HTTP Set-Cookie must omit Secure: %v", got.Header().Values("Set-Cookie"))
	}
}

func TestWriteSessionCookiePairSecurePathUsesSetCookie(t *testing.T) {
	got := httptest.NewRecorder()
	writeSessionCookiePair(got, "sess", "csrf", 60, true, false)
	assertRawFirstPartySetCookie(t, got, true)

	want := httptest.NewRecorder()
	http.SetCookie(want, &http.Cookie{
		Name: session.CookieName, Value: "sess", Path: session.CookiePath,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteLaxMode, MaxAge: 60,
	})
	http.SetCookie(want, &http.Cookie{
		Name: session.CSRFCookieName, Value: "csrf", Path: session.CookiePath,
		HttpOnly: false, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: 60,
	})
	if diff := cmpSetCookie(want, got); diff != "" {
		t.Fatal(diff)
	}
}

func cmpSetCookie(want, got *httptest.ResponseRecorder) string {
	w := want.Header().Values("Set-Cookie")
	g := got.Header().Values("Set-Cookie")
	if strings.Join(w, "\n") != strings.Join(g, "\n") {
		return "Set-Cookie mismatch\nwant:\n" + strings.Join(w, "\n") + "\ngot:\n" + strings.Join(g, "\n")
	}
	return ""
}

func TestWriteSessionCookiePairSetCookieAttributes(t *testing.T) {
	rec := httptest.NewRecorder()
	writeSessionCookiePair(rec, "sess", "csrf", 60, false, true)
	assertRawCHIPSSetCookie(t, rec)

	first := httptest.NewRecorder()
	writeSessionCookiePair(first, "sess", "csrf", 60, true, false)
	assertRawFirstPartySetCookie(t, first, true)
}

func assertRawCHIPSSetCookie(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	raw := rec.Header().Values("Set-Cookie")
	if len(raw) < 2 {
		t.Fatalf("expected ff_session and ff_csrf Set-Cookie, got %v", raw)
	}
	joined := strings.Join(raw, "\n")
	if !strings.Contains(strings.ToLower(joined), "samesite=none") {
		t.Fatalf("embed Set-Cookie must be SameSite=None: %v", raw)
	}
	if strings.Contains(strings.ToLower(joined), "samesite=lax") || strings.Contains(strings.ToLower(joined), "samesite=strict") {
		t.Fatalf("embed Set-Cookie must not use Lax/Strict: %v", raw)
	}
	for _, line := range raw {
		lower := strings.ToLower(line)
		if !strings.Contains(lower, "secure") {
			t.Fatalf("CHIPS Set-Cookie must keep Secure: %s", line)
		}
		if !strings.Contains(lower, "partitioned") {
			t.Fatalf("CHIPS Set-Cookie must include Partitioned: %s", line)
		}
		if !strings.Contains(line, "Path="+session.CookiePath) {
			t.Fatalf("cookie path: %s", line)
		}
	}
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
		t.Fatal("expected parsed ff_session and ff_csrf")
	}
	if !sessionCookie.HttpOnly {
		t.Fatal("ff_session must stay HttpOnly")
	}
	if csrfCookie.HttpOnly {
		t.Fatal("ff_csrf must stay readable")
	}
	if sessionCookie.SameSite != http.SameSiteNoneMode || csrfCookie.SameSite != http.SameSiteNoneMode {
		t.Fatalf("SameSite session=%v csrf=%v", sessionCookie.SameSite, csrfCookie.SameSite)
	}
	if !sessionCookie.Secure || !csrfCookie.Secure {
		t.Fatal("CHIPS cookies must be Secure")
	}
	if !sessionCookie.Partitioned || !csrfCookie.Partitioned {
		t.Fatal("CHIPS cookies must be Partitioned")
	}
}

func assertRawFirstPartySetCookie(t *testing.T, rec *httptest.ResponseRecorder, secure bool) {
	t.Helper()
	raw := rec.Header().Values("Set-Cookie")
	joined := strings.ToLower(strings.Join(raw, "\n"))
	if strings.Contains(joined, "samesite=none") || strings.Contains(joined, "partitioned") {
		t.Fatalf("first-party Set-Cookie must not be CHIPS: %v", raw)
	}
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
		t.Fatal("expected parsed ff_session and ff_csrf")
	}
	if sessionCookie.SameSite != http.SameSiteLaxMode || csrfCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("SameSite session=%v csrf=%v", sessionCookie.SameSite, csrfCookie.SameSite)
	}
	if sessionCookie.Partitioned || csrfCookie.Partitioned {
		t.Fatal("first-party cookies must not be Partitioned")
	}
	if sessionCookie.Secure != secure || csrfCookie.Secure != secure {
		t.Fatalf("Secure session=%v csrf=%v want %v", sessionCookie.Secure, csrfCookie.Secure, secure)
	}
}
