package opsalert

import (
	"context"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestSanitizeDropsSecretsKeepsIdentifiers(t *testing.T) {
	execID := "11111111-1111-4111-8111-111111111111"
	actor := "22222222-2222-4222-8222-222222222222"
	got := Sanitize(Signal{
		Kind:          KindRedaction,
		Action:        "artifact.upload",
		ResourceType:  "execution",
		ResourceID:    execID,
		CorrelationID: "corr-e54-fixture-1",
		RequestID:     "req-e54-fixture-1",
		ActorID:       actor,
		Outcome:       "denied",
		Code:          "invalid-request",
		Details: map[string]any{
			"executionId":   execID,
			"token":         "super-secret-token",
			"authorization": "Bearer abc.def.ghi",
			"password":      "hunter2",
			"kubeconfig":    "apiVersion: v1",
			"reason":        "unsafe-content",
			"nested":        map[string]any{"token": "still-secret"},
			"dsn":           "postgres://flowforge:change-me@db/ff",
		},
	})
	if got.Kind != KindRedaction || got.Severity != SeverityCritical {
		t.Fatalf("kind/severity = %+v", got)
	}
	if got.ResourceID != execID || got.ActorID != actor {
		t.Fatalf("ids = %+v", got)
	}
	if got.Details["executionId"] != execID || got.Details["reason"] != "unsafe-content" {
		t.Fatalf("details = %#v", got.Details)
	}
	for _, leak := range []string{"token", "authorization", "password", "kubeconfig", "nested", "dsn"} {
		if _, ok := got.Details[leak]; ok {
			t.Fatalf("secret key %s leaked: %#v", leak, got.Details)
		}
	}
	if containsSecret(got) {
		t.Fatalf("sanitized signal still contains secret material: %+v", got)
	}
}

func TestRouterRoutesSafeFixtures(t *testing.T) {
	scope, err := isolation.Authorize("33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444")
	if err != nil {
		t.Fatal(err)
	}
	sink := &RecordingSink{}
	router := NewRouter(sink)
	fixtures := []Signal{
		{Kind: KindAuthorization, Action: "workflow.execute", ResourceType: "workflow", ResourceID: "55555555-5555-4555-8555-555555555555", Code: "forbidden", Details: map[string]any{"token": "super-secret-token", "executionId": "55555555-5555-4555-8555-555555555555"}},
		{Kind: KindReplay, Action: "workflow.execute", ResourceType: "execution", ResourceID: "66666666-6666-4666-8666-666666666666", Code: "conflict", CorrelationID: "corr-replay", Details: map[string]any{"authorization": "Bearer leaked"}},
		{Kind: KindPolicy, Action: "workflow.execute", ResourceType: "workflow", ResourceID: "77777777-7777-4777-8777-777777777777", Code: "forbidden", Details: map[string]any{"reason": "policy-deny", "password": "nope"}},
		{Kind: KindRedaction, Action: "artifact.upload", ResourceType: "execution", ResourceID: "88888888-8888-4888-8888-888888888888", Code: "invalid-request", Details: map[string]any{"reason": "unsafe-content", "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"}},
	}
	for _, fix := range fixtures {
		alert, err := router.Route(context.Background(), scope, fix)
		if err != nil {
			t.Fatal(err)
		}
		if !KnownKind(alert.Kind) {
			t.Fatalf("unknown kind %q", alert.Kind)
		}
		if containsSecret(alert) {
			t.Fatalf("routed alert leaked secrets: %+v details=%#v", alert, alert.Details)
		}
	}
	if len(sink.Alerts) != 4 {
		t.Fatalf("routed %d, want 4", len(sink.Alerts))
	}
}

func containsSecret(v any) bool {
	s := strings.ToLower(stringify(v))
	for _, needle := range []string{"super-secret", "bearer ", "hunter2", "change-me", "private key", "leaked"} {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}

func stringify(v any) string {
	switch t := v.(type) {
	case Signal:
		return t.Kind + t.Action + t.ResourceID + t.CorrelationID + t.RequestID + t.Code + stringify(t.Details)
	case Alert:
		return t.Kind + t.Action + t.ResourceID + t.CorrelationID + t.RequestID + t.Code + stringify(t.Details)
	case map[string]any:
		out := ""
		for k, child := range t {
			out += k + stringify(child)
		}
		return out
	case string:
		return t
	default:
		return ""
	}
}
