package observability

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestRedactingHandlerRemovesSecretKeys(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	log.Info("auth attempt",
		"authorization", "Bearer super-secret-token",
		"password", "hunter2",
		"DATABASE_URL", "postgres://flowforge:change-me@postgres:5432/flowforge",
		"request_id", "abcdefghijklmnop",
		"path", "/api/v1/health",
	)
	out := buf.String()
	for _, secret := range []string{"super-secret-token", "hunter2", "change-me"} {
		if strings.Contains(out, secret) {
			t.Fatalf("secret %q leaked: %s", secret, out)
		}
	}
	if !strings.Contains(out, redacted) {
		t.Fatalf("expected redacted placeholder: %s", out)
	}
	if !strings.Contains(out, "abcdefghijklmnop") {
		t.Fatalf("request_id should remain: %s", out)
	}
	if !strings.Contains(out, "/api/v1/health") {
		t.Fatalf("path should remain: %s", out)
	}
}

func TestRedactingHandlerRedactsDSNValues(t *testing.T) {
	var buf bytes.Buffer
	log := slog.New(NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	log.Error("connect", "error", errors.New("postgres://flowforge:s3cret@db:5432/flowforge?sslmode=disable"))
	out := buf.String()
	if strings.Contains(out, "s3cret") {
		t.Fatalf("dsn password leaked: %s", out)
	}
}

func TestShouldRedactKey(t *testing.T) {
	if !shouldRedactKey("Authorization") || !shouldRedactKey("client_secret") {
		t.Fatal("expected secret keys to redact")
	}
	if shouldRedactKey("request_id") || shouldRedactKey("status") || shouldRedactKey("timeout") {
		t.Fatal("safe keys should not redact")
	}
}
