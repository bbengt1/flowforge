package httpapi

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

// freezeWriter snapshots headers at WriteHeader. Later Header().Set calls
// are discarded, matching net/http's server.
type freezeWriter struct {
	live http.Header
	sent http.Header
	code int
	body bytes.Buffer
}

func (f *freezeWriter) Header() http.Header {
	if f.live == nil {
		f.live = make(http.Header)
	}
	if f.sent != nil {
		return make(http.Header)
	}
	return f.live
}

func (f *freezeWriter) WriteHeader(code int) {
	if f.sent != nil {
		return
	}
	if f.live == nil {
		f.live = make(http.Header)
	}
	f.code = code
	f.sent = f.live.Clone()
}

func (f *freezeWriter) Write(p []byte) (int, error) {
	if f.sent == nil {
		f.WriteHeader(http.StatusOK)
	}
	return f.body.Write(p)
}

func TestResponseCarriesW3CTraceParent(t *testing.T) {
	const inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	h := NewWithStore(nil, identity.NewMemory())
	rec := &freezeWriter{}
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set(observability.TraceParentHeader, inbound)
	req.Header.Set(observability.TraceStateHeader, "rojo=bearer super-secret-plaintext")
	h.ServeHTTP(rec, req)
	if rec.code != http.StatusOK {
		t.Fatalf("status = %d", rec.code)
	}
	got := rec.sent.Get(observability.TraceParentHeader)
	if !observability.ValidTraceParent(got) {
		t.Fatalf("traceparent = %q", got)
	}
	if !strings.Contains(got, "4bf92f3577b34da6a3ce929d0e0e4736") {
		t.Fatalf("response traceparent %q dropped the inbound trace", got)
	}
	if got == inbound {
		t.Fatal("response traceparent must be the server span, not the inbound header echoed unchanged")
	}
	if strings.Contains(strings.ToLower(rec.sent.Get(observability.TraceStateHeader)), "secret") ||
		strings.Contains(strings.ToLower(rec.sent.Get(observability.TraceStateHeader)), "bearer") {
		t.Fatalf("tracestate leaked: %q", rec.sent.Get(observability.TraceStateHeader))
	}
}

func TestMetricsKeepHTTPSeriesAndMachineShape(t *testing.T) {
	h := NewWithStore(nil, identity.NewMemory())
	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, identifiedRequest(http.MethodGet, "/api/v1/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if !strings.Contains(body, "flowforge_http_requests_total") {
		t.Fatalf("missing hand-rolled counter: %s", body)
	}
	if strings.Contains(body, "caller-request-16") || strings.Contains(strings.ToLower(body), "bearer") {
		t.Fatalf("metrics leaked correlation or credentials: %s", body)
	}
}
