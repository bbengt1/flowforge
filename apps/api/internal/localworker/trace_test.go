package localworker

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func TestClaimTraceIsSentOnComplete(t *testing.T) {
	if err := observability.Install(context.Background()); err != nil {
		t.Fatal(err)
	}
	const inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
	var completeParent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/v1/jobs/claim":
			w.Header().Set(observability.TraceParentHeader, inbound)
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"claimed":  true,
				"jobToken": "ticket-token-value",
				"job": map[string]any{
					"id":              "11111111-1111-4111-8111-111111111111",
					"executionId":     "22222222-2222-4222-8222-222222222222",
					"executionStepId": "33333333-3333-4333-8333-333333333333",
					"status":          "claimed",
					"availableAt":     time.Now().UTC(),
					"fencingToken":    1,
					"attempt":         1,
					"createdAt":       time.Now().UTC(),
					"updatedAt":       time.Now().UTC(),
				},
			})
		case strings.HasSuffix(r.URL.Path, "/complete"):
			completeParent = r.Header.Get(observability.TraceParentHeader)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)

	client := NewHTTP(HTTPConfig{
		BaseURL:  srv.URL,
		Issuer:   "https://idp.example",
		Subject:  "worker-1",
		WorkerID: "worker-1",
	})
	claim, err := client.Claim(context.Background(), "tenant", "bench")
	if err != nil {
		t.Fatal(err)
	}
	if claim == nil || claim.TraceParent != inbound {
		t.Fatalf("claim trace = %+v", claim)
	}
	if err := client.Complete(context.Background(), "tenant", "bench", *claim, map[string]any{"ok": true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(completeParent, "4bf92f3577b34da6a3ce929d0e0e4736") {
		t.Fatalf("complete traceparent = %q", completeParent)
	}
	if strings.Contains(strings.ToLower(completeParent), "bearer") {
		t.Fatalf("complete trace leaked: %q", completeParent)
	}
}

func TestReadyDoesNotRequireTrace(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"status":"ready"}`)
	}))
	t.Cleanup(srv.Close)
	client := NewHTTP(HTTPConfig{BaseURL: srv.URL, Issuer: "https://idp.example", Subject: "worker-1", WorkerID: "worker-1"})
	if err := client.Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
}
