package observability

import (
	"strings"
	"testing"
	"time"
)

func TestRegistryObserveAndExpose(t *testing.T) {
	reg := NewRegistry()
	reg.Observe("GET", "GET /api/v1/health", 200, 12*time.Millisecond)
	reg.Observe("GET", "GET /api/v1/health", 200, 3*time.Millisecond)
	reg.Observe("POST", "unmatched", 404, 1*time.Millisecond)

	var b strings.Builder
	if err := reg.WritePrometheus(&b); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	if !strings.Contains(out, `flowforge_http_requests_total{method="GET",route="GET /api/v1/health",status="200"} 2`) {
		t.Fatalf("missing counter: %s", out)
	}
	if !strings.Contains(out, `flowforge_http_requests_total{method="POST",route="unmatched",status="404"} 1`) {
		t.Fatalf("missing unmatched counter: %s", out)
	}
	if !strings.Contains(out, `flowforge_http_request_duration_seconds_count{method="GET",route="GET /api/v1/health"} 2`) {
		t.Fatalf("missing histogram count: %s", out)
	}
	if strings.Contains(out, "authorization") || strings.Contains(out, "request_id") {
		t.Fatalf("metrics must not include secrets or correlation ids: %s", out)
	}
}
