package config

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestDurationEnv(t *testing.T) {
	t.Setenv("MIGRATE_TIMEOUT", "2m")
	if got := durationEnv("MIGRATE_TIMEOUT", defaultMigrateTimeout); got != 2*time.Minute {
		t.Fatalf("got %s", got)
	}
	t.Setenv("MIGRATE_TIMEOUT", "nope")
	if got := durationEnv("MIGRATE_TIMEOUT", defaultMigrateTimeout); got != defaultMigrateTimeout {
		t.Fatalf("invalid duration should fall back, got %s", got)
	}
}

func TestParseCIDRs(t *testing.T) {
	nets, err := parseCIDRs("10.0.0.0/8, 192.168.1.1, ::1")
	if err != nil {
		t.Fatal(err)
	}
	if len(nets) != 3 {
		t.Fatalf("len = %d, want 3", len(nets))
	}
	if !nets[0].Contains(mustIP("10.9.8.7")) {
		t.Fatal("10.0.0.0/8 should contain 10.9.8.7")
	}
	if !nets[1].Contains(mustIP("192.168.1.1")) || nets[1].Contains(mustIP("192.168.1.2")) {
		t.Fatal("bare IPv4 should become /32")
	}

	if _, err := parseCIDRs("not-a-cidr"); err == nil {
		t.Fatal("expected invalid CIDR error")
	}
	empty, err := parseCIDRs("  ")
	if err != nil || empty != nil {
		t.Fatalf("empty should be nil, got %v err=%v", empty, err)
	}
}

func TestParseOrigins(t *testing.T) {
	got, err := parseOrigins("https://app.example, http://localhost:3000")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "https://app.example" || got[1] != "http://localhost:3000" {
		t.Fatalf("got %#v", got)
	}
	if _, err := parseOrigins("*"); err == nil {
		t.Fatal("wildcard must fail closed")
	}
	if _, err := parseOrigins("null"); err == nil {
		t.Fatal("null origin must fail closed")
	}
	if _, err := parseOrigins("https://app.example/path"); err == nil {
		t.Fatal("path must be rejected")
	}
	empty, err := parseOrigins("  ")
	if err != nil || empty != nil {
		t.Fatalf("empty should be nil, got %v err=%v", empty, err)
	}
}

func TestLoadRejectsWildcardCORS(t *testing.T) {
	t.Setenv("CORS_ALLOWED_ORIGINS", "*")
	if _, err := Load(); err == nil {
		t.Fatal("expected wildcard CORS load error")
	}
}

func TestBoolEnv(t *testing.T) {
	t.Setenv("REQUIRE_TLS", "true")
	if !boolEnv("REQUIRE_TLS", false) {
		t.Fatal("true should enable")
	}
	t.Setenv("REQUIRE_TLS", "nope")
	if boolEnv("REQUIRE_TLS", false) {
		t.Fatal("unknown value should fall back")
	}
}

func TestLoadTLSFilesMustBePaired(t *testing.T) {
	t.Setenv("TLS_CERT_FILE", "/tmp/cert.pem")
	t.Setenv("TLS_KEY_FILE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected paired TLS file error")
	}
}

func mustIP(s string) net.IP {
	ip := net.ParseIP(s)
	if ip == nil {
		panic(s)
	}
	return ip
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
