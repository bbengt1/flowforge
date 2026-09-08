package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListenAddrDefaults(t *testing.T) {
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("PORT", "")
	if got := listenAddr(); got != defaultHTTPAddr {
		t.Fatalf("listenAddr() = %q, want %q", got, defaultHTTPAddr)
	}
}

func TestListenAddrFromPort(t *testing.T) {
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("PORT", "9090")
	if got := listenAddr(); got != ":9090" {
		t.Fatalf("listenAddr() = %q, want :9090", got)
	}
}

func TestListenAddrPrefersHTTPAddr(t *testing.T) {
	t.Setenv("HTTP_ADDR", "127.0.0.1:8081")
	t.Setenv("PORT", "9090")
	if got := listenAddr(); got != "127.0.0.1:8081" {
		t.Fatalf("listenAddr() = %q, want 127.0.0.1:8081", got)
	}
}

func TestDatabaseURLFromPartsURLEncodesPassword(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("POSTGRES_HOST", "postgres")
	t.Setenv("POSTGRES_PORT", "5432")
	t.Setenv("POSTGRES_USER", "flowforge")
	t.Setenv("POSTGRES_PASSWORD", "p@ss:word")
	t.Setenv("POSTGRES_DB", "flowforge")
	t.Setenv("POSTGRES_SSLMODE", "disable")

	got := databaseURL()
	if !strings.Contains(got, "p%40ss%3Aword") {
		t.Fatalf("databaseURL() = %q, want password percent-encoded", got)
	}
	if !strings.Contains(got, "postgres:5432/flowforge") {
		t.Fatalf("databaseURL() = %q, want host/db", got)
	}
}

func TestLoadDotEnvDoesNotOverrideEnv(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	if err := os.WriteFile(path, []byte("HTTP_ADDR=:7777\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HTTP_ADDR", ":8080")
	applyDotEnvFile(path)
	if got := os.Getenv("HTTP_ADDR"); got != ":8080" {
		t.Fatalf("HTTP_ADDR = %q, existing env should win", got)
	}
}
