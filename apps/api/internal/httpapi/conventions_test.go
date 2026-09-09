package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"gopkg.in/yaml.v3"
)

func TestInvalidRequestProblemDetails(t *testing.T) {
	h := New(nil)

	t.Run("not found", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil)
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")
	})

	t.Run("method not allowed", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(`{"x":1}`))
		req.Header.Set(RequestIDHeader, "caller-request-16")
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "caller-request-16")
		if rec.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("Allow = %q", rec.Header().Get("Allow"))
		}
	})

	t.Run("request too large", func(t *testing.T) {
		rec := httptest.NewRecorder()
		body := strings.Repeat("x", int(MaxRequestBody)+1)
		req := httptest.NewRequest(http.MethodPost, "/api/v1/health", strings.NewReader(body))
		req.ContentLength = int64(len(body))
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusRequestEntityTooLarge, CodeRequestTooLarge, "caller-request-16")
	})
}

func TestDecodeJSONInvalidRequest(t *testing.T) {
	h := withRequestID(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if !DecodeJSON(w, r, &payload) {
			return
		}
		writeJSON(w, http.StatusOK, payload)
	}))

	t.Run("malformed json", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/example", strings.NewReader(`{"password":"should-not-appear"`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		p := assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
		if strings.Contains(rec.Body.String(), "should-not-appear") {
			t.Fatal("problem detail echoed request body")
		}
		if p.Detail == "" {
			t.Fatal("empty detail")
		}
	})

	t.Run("wrong content type", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/example", strings.NewReader(`{"ok":true}`))
		req.Header.Set("Content-Type", "text/plain")
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	})

	t.Run("empty body", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/example", http.NoBody)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	})
}

func TestAuthenticatedRequestProblemDetails(t *testing.T) {
	t.Run("unauthenticated", func(t *testing.T) {
		h := withRequestID(http.HandlerFunc(WriteUnauthenticated))
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/example", nil)
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	})

	t.Run("forbidden", func(t *testing.T) {
		h := withRequestID(http.HandlerFunc(WriteForbidden))
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/v1/example", nil)
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(rec, req)
		assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
	})
}

func TestCorrelationIDPropagatedToLogsAndProblems(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	prev := slog.Default()
	slog.SetDefault(log)
	t.Cleanup(func() { slog.SetDefault(prev) })

	h := New(nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	req.Header.Set("Authorization", "Bearer super-secret-token")
	req.Header.Set("Cookie", "session=super-secret-cookie")
	req.URL.RawQuery = "access_token=should-not-be-logged"
	h.ServeHTTP(rec, req)

	p := assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "caller-request-16")
	if p.RequestID != "caller-request-16" {
		t.Fatalf("problem request_id = %q", p.RequestID)
	}
	if rec.Header().Get(RequestIDHeader) != "caller-request-16" {
		t.Fatalf("response header = %q", rec.Header().Get(RequestIDHeader))
	}

	out := buf.String()
	if !strings.Contains(out, `"request_id":"caller-request-16"`) {
		t.Fatalf("access log missing correlation id: %s", out)
	}
	if !strings.Contains(out, `"path":"/api/v1/missing"`) {
		t.Fatalf("access log missing path: %s", out)
	}
	for _, secret := range []string{"super-secret-token", "super-secret-cookie", "should-not-be-logged", "access_token="} {
		if strings.Contains(out, secret) {
			t.Fatalf("secret %q leaked into logs: %s", secret, out)
		}
	}
}

func TestGeneratedRequestIDUsedWhenCallerInvalid(t *testing.T) {
	h := New(nil)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil)
	req.Header.Set(RequestIDHeader, "nope")
	h.ServeHTTP(rec, req)
	id := rec.Header().Get(RequestIDHeader)
	if !validRequestID(id) {
		t.Fatalf("generated id invalid: %q", id)
	}
	p := assertProblem(t, rec, http.StatusNotFound, CodeNotFound, id)
	if p.RequestID != id {
		t.Fatalf("problem request_id = %q header = %q", p.RequestID, id)
	}
}

func TestRecoverWritesInternalProblem(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	h := withRequestID(withObserve(log, observability.NewRegistry(), withRecover(log, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("boom")
	}))))
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/health", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	p := assertProblem(t, rec, http.StatusInternalServerError, CodeInternalError, "caller-request-16")
	if strings.Contains(p.Detail, "boom") {
		t.Fatal("panic text leaked to client")
	}
}

func TestMetricsEndpoint(t *testing.T) {
	h := New(nil)
	health := httptest.NewRecorder()
	h.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d", health.Code)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get(RequestIDHeader) != "caller-request-16" {
		t.Fatalf("missing correlation header")
	}
	body := rec.Body.String()
	if !strings.Contains(body, "flowforge_http_requests_total") {
		t.Fatalf("missing counter: %s", body)
	}
	if !strings.Contains(body, `route="GET /api/v1/health"`) {
		t.Fatalf("missing health route label: %s", body)
	}
	if strings.Contains(body, "caller-request-16") {
		t.Fatal("metrics must not include correlation ids")
	}
}

func TestOpenAPIDocumentsImplementedRoutesAndProblems(t *testing.T) {
	var doc map[string]any
	if err := yaml.Unmarshal(mustOpenAPIYAML(), &doc); err != nil {
		t.Fatal(err)
	}
	paths, _ := doc["paths"].(map[string]any)
	for _, p := range []string{
		"/health", "/readiness", "/metrics", "/openapi.yaml", "/openapi.json", "/swagger",
		"/session", "/session/refresh", "/session/logout", "/session/audit-events",
		"/permission-matrix", "/roles", "/permissions", "/tenants", "/workspaces", "/workspace",
		"/workspace/members", "/workspace/records", "/workspace/credentials/{id}/use",
		"/workspace/artifacts/{id}", "/workspace/jobs", "/workspace/cache/{key}",
		"/workspace/realtime/channels/{id}/subscribe", "/workspace/audit-events",
		"/workflows/catalog", "/workflows/validate", "/workflows/normalize",
		"/workflows", "/workflows/{workflowId}", "/workflows/{workflowId}/draft",
		"/workflows/{workflowId}/publish", "/workflows/{workflowId}/compare",
		"/workflows/{workflowId}/versions", "/workflows/{workflowId}/versions/{versionId}",
		"/workflows/{workflowId}/versions/{versionId}/export",
		"/workflows/{workflowId}/versions/{versionId}/restore",
		"/workflows/{workflowId}/executions",
		"/workflows/{workflowId}/executions/{executionId}",
		"/executions",
		"/executions/{executionId}",
		"/executions/{executionId}/steps",
		"/executions/{executionId}/steps/{stepId}",
		"/executions/{executionId}/jobs",
		"/executions/{executionId}/audit-events",
		"/executions/{executionId}/cancel",
		"/executions/{executionId}/retry",
		"/executions/{executionId}/steps/{stepId}/retry",
		"/executions/{executionId}/artifacts",
		"/executions/{executionId}/steps/{stepId}/artifacts",
		"/executions/{executionId}/steps/{stepId}/logs",
		"/artifacts/{artifactId}",
		"/artifacts/{artifactId}/downloads",
		"/artifact-downloads/{grantId}",
		"/artifacts/{artifactId}/legal-hold",
		"/retention/purge",
		"/jobs/claim",
		"/jobs/recover",
		"/jobs/{jobId}/heartbeat",
		"/jobs/{jobId}/release",
		"/jobs/{jobId}/complete",
		"/jobs/{jobId}/fail",
		"/audit-events",
		"/alerts",
		"/alerts/{alertId}",
		"/alerts/{alertId}/ack",
		"/credentials/catalog", "/credentials", "/credentials/{credentialId}",
		"/credentials/{credentialId}/rotate", "/credentials/{credentialId}/disable",
		"/credentials/{credentialId}/enable", "/credentials/{credentialId}/test",
		"/credentials/{credentialId}/use", "/credentials/{credentialId}/usage",
		"/credentials/{credentialId}/deletion-impact",
		"/credentials/{credentialId}/events",
		"/ops-config/catalog", "/ops-config/select",
		"/cluster-targets", "/cluster-targets/{resourceId}",
		"/cluster-targets/{resourceId}/draft", "/cluster-targets/{resourceId}/publish",
		"/cluster-targets/{resourceId}/versions", "/cluster-targets/{resourceId}/versions/{versionId}",
		"/cluster-targets/{resourceId}/disable", "/cluster-targets/{resourceId}/enable",
		"/cluster-targets/{resourceId}/select",
		"/ssh-targets", "/command-profiles", "/runtime-profiles", "/connections",
		"/recipient-lists", "/message-templates", "/response-schemas", "/policies",
		"/workflows/{workflowId}/versions/{versionId}/pins",
		"/policy/evaluate", "/approvals/catalog", "/approvals",
		"/approvals/{approvalId}", "/approvals/{approvalId}/decide",
		"/approvals/{approvalId}/events",
	} {
		if paths[p] == nil {
			t.Fatalf("openapi missing path %s", p)
		}
	}

	h := New(nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/openapi.json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	var published map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	pubPaths, _ := published["paths"].(map[string]any)
	if pubPaths["/metrics"] == nil {
		t.Fatal("published json missing /metrics")
	}

	components, _ := published["components"].(map[string]any)
	schemas, _ := components["schemas"].(map[string]any)
	problem, _ := schemas["Problem"].(map[string]any)
	props, _ := problem["properties"].(map[string]any)
	code, _ := props["code"].(map[string]any)
	enums, _ := code["enum"].([]any)
	want := map[string]bool{
		CodeInvalidRequest: true, CodeUnauthenticated: true, CodeForbidden: true,
		CodeNotFound: true, CodeConflict: true, CodeMethodNotAllowed: true, CodeRequestTooLarge: true,
		CodeInternalError: true, CodeDependencyUnavailable: true,
		CodeInvalidWorkflow: true,
	}
	for _, v := range enums {
		s, _ := v.(string)
		delete(want, s)
	}
	if len(want) > 0 {
		t.Fatalf("published Problem.code enum missing %v", want)
	}
}

func assertProblem(t *testing.T, rec *httptest.ResponseRecorder, status int, code, requestID string) Problem {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d body=%s", rec.Code, status, rec.Body.String())
	}
	if rec.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("content-type = %q", rec.Header().Get("Content-Type"))
	}
	var p Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatal(err)
	}
	if p.Type != problemTypePrefix+code {
		t.Fatalf("type = %q", p.Type)
	}
	if p.Title == "" || p.Detail == "" || p.Instance == "" {
		t.Fatalf("incomplete problem: %+v", p)
	}
	if p.Status != status {
		t.Fatalf("problem status = %d, want %d", p.Status, status)
	}
	if p.Code != code {
		t.Fatalf("code = %q, want %q", p.Code, code)
	}
	if requestID != "" && p.RequestID != requestID {
		t.Fatalf("request_id = %q, want %q", p.RequestID, requestID)
	}
	if requestID != "" && rec.Header().Get(RequestIDHeader) != requestID {
		t.Fatalf("X-Request-ID = %q, want %q", rec.Header().Get(RequestIDHeader), requestID)
	}
	return p
}
