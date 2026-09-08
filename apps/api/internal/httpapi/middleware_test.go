package httpapi

import (
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequireTLSRejectsPlainHTTP(t *testing.T) {
	h := NewWithSecurity(nil, Security{RequireTLS: true})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if rec.Header().Get("Strict-Transport-Security") != "" {
		t.Fatal("HSTS must not be set on rejected plain HTTP")
	}
}

func TestRequireTLSAcceptsDirectTLS(t *testing.T) {
	h := NewWithSecurity(nil, Security{RequireTLS: true})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.TLS = &tls.ConnectionState{}
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Strict-Transport-Security") != "max-age=31536000; includeSubDomains" {
		t.Fatalf("HSTS = %q", rec.Header().Get("Strict-Transport-Security"))
	}
}

func TestForwardedProtoTrustedOnly(t *testing.T) {
	_, network, err := net.ParseCIDR("10.0.0.0/8")
	if err != nil {
		t.Fatal(err)
	}
	h := NewWithSecurity(nil, Security{RequireTLS: true, TrustedProxies: []*net.IPNet{network}})

	t.Run("trusted proxy", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
		req.RemoteAddr = "10.1.2.3:443"
		req.Header.Set("X-Forwarded-Proto", "https")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status = %d", rec.Code)
		}
		if rec.Header().Get("Strict-Transport-Security") == "" {
			t.Fatal("expected HSTS from trusted proxy proto")
		}
	})

	t.Run("untrusted forwarded proto ignored", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
		req.RemoteAddr = "203.0.113.9:443"
		req.Header.Set("X-Forwarded-Proto", "https")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", rec.Code)
		}
	})
}

func TestValidRequestID(t *testing.T) {
	if validRequestID("short") {
		t.Fatal("too short")
	}
	if !validRequestID("abcdefghijklmnop") {
		t.Fatal("16 letters should pass")
	}
	if !validRequestID("01234567-89ab-cdef") {
		t.Fatal("hyphens should pass")
	}
	if validRequestID("abcdefghijklmno_") {
		t.Fatal("underscore should fail")
	}
}
