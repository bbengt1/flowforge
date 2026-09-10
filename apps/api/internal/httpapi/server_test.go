package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

func TestHealthOK(t *testing.T) {
	h := New(ReadyChecker(func(context.Context) error {
		return errors.New("db should not be consulted")
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	assertJSONStatus(t, rec.Body.Bytes(), "ok")
	assertFoundationHeaders(t, rec)
}

func TestReadinessReady(t *testing.T) {
	h := New(ReadyChecker(func(context.Context) error { return nil }))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/readiness", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	assertJSONStatus(t, rec.Body.Bytes(), "ready")
	assertFoundationHeaders(t, rec)
}

func TestReadinessUnavailable(t *testing.T) {
	h := New(ReadyChecker(func(context.Context) error {
		return errors.New("connection refused")
	}))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/readiness", nil)
	req.Header.Set("X-Request-ID", "caller-request-16")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	ct := rec.Header().Get("Content-Type")
	if ct != "application/problem+json" {
		t.Fatalf("content-type = %q", ct)
	}
	var p Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != "dependency-unavailable" {
		t.Fatalf("code = %q", p.Code)
	}
	if p.Status != 503 {
		t.Fatalf("problem status = %d", p.Status)
	}
	if p.Type != "urn:flowforge:problem:dependency-unavailable" {
		t.Fatalf("type = %q", p.Type)
	}
	if p.Title == "" || p.Detail == "" || p.Instance != "/api/v1/readiness" {
		t.Fatalf("incomplete problem: %+v", p)
	}
	if p.RequestID != "caller-request-16" {
		t.Fatalf("request_id = %q", p.RequestID)
	}
	if rec.Header().Get("X-Request-ID") != "caller-request-16" {
		t.Fatalf("response X-Request-ID = %q", rec.Header().Get("X-Request-ID"))
	}
}

func TestReadinessNilChecker(t *testing.T) {
	h := New(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/readiness", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
}

func TestRequestIDGeneratedWhenInvalid(t *testing.T) {
	h := New(nil)
	cases := []string{"", "too-short", "has_underscore_xx", "spaces are bad!!", "unicode-åååååååå"}
	for _, in := range cases {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
		if in != "" {
			req.Header.Set("X-Request-ID", in)
		}
		h.ServeHTTP(rec, req)
		got := rec.Header().Get("X-Request-ID")
		if !validRequestID(got) {
			t.Fatalf("input %q produced invalid id %q", in, got)
		}
		if got == in {
			t.Fatalf("invalid caller id %q was accepted", in)
		}
	}
}

func TestRequestIDAcceptsValidCallerValue(t *testing.T) {
	h := New(nil)
	id := strings.Repeat("a", 16)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-ID", id)
	h.ServeHTTP(rec, req)
	if rec.Header().Get("X-Request-ID") != id {
		t.Fatalf("got %q want %q", rec.Header().Get("X-Request-ID"), id)
	}

	longID := strings.Repeat("b", 128)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-ID", longID)
	h.ServeHTTP(rec, req)
	if rec.Header().Get("X-Request-ID") != longID {
		t.Fatalf("128-char id not accepted")
	}

	tooLong := strings.Repeat("c", 129)
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set("X-Request-ID", tooLong)
	h.ServeHTTP(rec, req)
	if rec.Header().Get("X-Request-ID") == tooLong {
		t.Fatal("129-char id should be rejected")
	}
}

func TestNotFoundProblem(t *testing.T) {
	h := New(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
	var p Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != "not-found" {
		t.Fatalf("code = %q", p.Code)
	}
}

func TestMethodNotAllowedProblem(t *testing.T) {
	h := New(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/health", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", rec.Code)
	}
	var p Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Code != "method-not-allowed" {
		t.Fatalf("code = %q", p.Code)
	}
	if rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("Allow = %q, want GET, HEAD", rec.Header().Get("Allow"))
	}
}

func TestOpenAPIAndSwagger(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedRequest(http.MethodGet, "/api/v1/openapi.yaml", nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "openapi:") {
		t.Fatalf("yaml: status=%d body=%s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedRequest(http.MethodGet, "/api/v1/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("json status = %d", rec.Code)
	}
	var doc map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	if doc["openapi"] == nil {
		t.Fatalf("json missing openapi key: %v", doc)
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedRequest(http.MethodGet, "/api/v1/swagger", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("swagger status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "/api/v1/openapi.yaml") {
		t.Fatalf("swagger landing page missing spec links")
	}

	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedRequest(http.MethodGet, "/api/v1/openapi.yaml", nil))
	if !strings.Contains(rec.Body.String(), "/metrics") {
		t.Fatal("openapi.yaml missing /metrics")
	}
}

func assertJSONStatus(t *testing.T, body []byte, want string) {
	t.Helper()
	var payload map[string]string
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatalf("json: %v body=%s", err, body)
	}
	if payload["status"] != want {
		t.Fatalf("status = %q, want %q", payload["status"], want)
	}
}

func assertFoundationHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if !validRequestID(rec.Header().Get("X-Request-ID")) {
		t.Fatalf("missing/invalid X-Request-ID: %q", rec.Header().Get("X-Request-ID"))
	}
	if rec.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("missing Content-Security-Policy")
	}
	if rec.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q", rec.Header().Get("Referrer-Policy"))
	}
	if rec.Header().Get("Permissions-Policy") == "" {
		t.Fatal("missing Permissions-Policy")
	}
}

func TestHealthDoesNotReadBody(t *testing.T) {
	h := New(nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", strings.NewReader("unused"))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	_, _ = io.ReadAll(rec.Body)
}
