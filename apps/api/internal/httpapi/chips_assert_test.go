package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

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
