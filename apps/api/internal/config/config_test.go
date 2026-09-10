package config

import (
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
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

func TestLoadTrustedDevIdentityHeadersFailClosed(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("FLOWFORGE_ENV", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.TrustIdentityHeaders {
		t.Fatal("empty config must fail closed")
	}

	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "1")
	if _, err := Load(); err == nil {
		t.Fatal("trusted-dev without APP_ENV must refuse to start")
	}

	t.Setenv("APP_ENV", "production")
	if _, err := Load(); err == nil {
		t.Fatal("trusted-dev in production must refuse to start")
	}

	t.Setenv("APP_ENV", "development")
	t.Setenv("REQUIRE_TLS", "true")
	if _, err := Load(); err == nil {
		t.Fatal("trusted-dev with REQUIRE_TLS must refuse to start")
	}

	t.Setenv("REQUIRE_TLS", "false")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.TrustIdentityHeaders {
		t.Fatal("explicit trusted-dev + APP_ENV=development must enable header identity")
	}
}

func TestLoadRejectsWildcardCORS(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
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

func TestLoadRejectsInvalidEmbedSigningKey(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("EMBED_SIGNING_KEY", "not-an-ed25519-key")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid EMBED_SIGNING_KEY error")
	}
}

func TestLoadRejectsNonFlowForgeEmbedAudience(t *testing.T) {
	t.Setenv("EMBED_AUDIENCE", "someone-else")
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected EMBED_AUDIENCE fail-closed")
	}
}

func TestLoadProductionMissingSigningKeyFails(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", "")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	if _, err := Load(); err == nil {
		t.Fatal("production missing EMBED_SIGNING_KEY must refuse to start")
	}

	t.Setenv("APP_ENV", "production")
	if _, err := Load(); err == nil {
		t.Fatal("APP_ENV=production missing signing key must refuse to start")
	}

	t.Setenv("APP_ENV", "development")
	t.Setenv("REQUIRE_TLS", "true")
	if _, err := Load(); err == nil {
		t.Fatal("REQUIRE_TLS missing signing key must refuse to start")
	}
}

func TestLoadMergesSharedHostAllowlist(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", "")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("PORTAL_FRAME_ANCESTORS", "https://portal.example *")
	t.Setenv("WEB_PORTAL_FRAME_ANCESTORS", "'self'")
	t.Setenv("WEB_EMBED_FRAME_ANCESTORS", "https://host.example null")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.PortalFrameAncestors) != 3 {
		t.Fatalf("merged allowlist %v", cfg.PortalFrameAncestors)
	}
	if cfg.PortalFrameAncestors[0] != "https://portal.example" || cfg.PortalFrameAncestors[1] != "'self'" || cfg.PortalFrameAncestors[2] != "https://host.example" {
		t.Fatalf("merged allowlist %v", cfg.PortalFrameAncestors)
	}

	t.Setenv("PORTAL_FRAME_ANCESTORS", "")
	t.Setenv("WEB_PORTAL_FRAME_ANCESTORS", "")
	t.Setenv("WEB_EMBED_FRAME_ANCESTORS", "")
	empty, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.PortalFrameAncestors) != 0 {
		t.Fatalf("empty allowlist must fail closed, got %v", empty.PortalFrameAncestors)
	}
}

func TestLoadEmbedNBFLeewayFromEnv(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", "")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "development")
	t.Setenv(embed.EnvNBFLeeway, "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EmbedNBFLeeway != embed.DefaultNBFLeeway {
		t.Fatalf("default nbf leeway %s", cfg.EmbedNBFLeeway)
	}

	t.Setenv(embed.EnvNBFLeeway, "15s")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EmbedNBFLeeway != 15*time.Second {
		t.Fatalf("custom nbf leeway %s", cfg.EmbedNBFLeeway)
	}

	t.Setenv(embed.EnvNBFLeeway, "5m")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EmbedNBFLeeway != embed.MaxNBFLeeway {
		t.Fatalf("over-max nbf leeway must clamp, got %s", cfg.EmbedNBFLeeway)
	}
}

func TestLoadEmbedRateLimitsFromEnv(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", "")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("EMBED_EXCHANGE_RATE_LIMIT_IP", "7")
	t.Setenv("EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL", "4")
	t.Setenv("EMBED_MINT_RATE_LIMIT_PRINCIPAL", "9")
	t.Setenv("EMBED_RATE_LIMIT_WINDOW", "30s")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.EmbedLimits.ExchangeIP != 7 || cfg.EmbedLimits.ExchangePrincipal != 4 {
		t.Fatalf("exchange limits %+v", cfg.EmbedLimits)
	}
	if cfg.EmbedLimits.MintPrincipal != 9 || cfg.EmbedLimits.Window != 30*time.Second {
		t.Fatalf("mint/window %+v", cfg.EmbedLimits)
	}
}

func TestLoadProductionRejectsHTTPIssuers(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("PORTAL_ISSUER", "")
	t.Setenv("PORTAL_ISSUER_ALLOWLIST", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "")

	t.Setenv("EMBED_ISSUER", "http://idp.example")
	t.Setenv("EMBED_ISSUER_ALLOWLIST", "")
	if _, err := Load(); err == nil {
		t.Fatal("empty APP_ENV must boot-fail on http EMBED_ISSUER")
	}

	t.Setenv("APP_ENV", "production")
	t.Setenv("EMBED_ISSUER", "https://idp.example")
	t.Setenv("EMBED_ISSUER_ALLOWLIST", "http://host-b.example")
	if _, err := Load(); err == nil {
		t.Fatal("production must boot-fail on http EMBED_ISSUER_ALLOWLIST")
	}

	t.Setenv("EMBED_ISSUER", "")
	t.Setenv("EMBED_ISSUER_ALLOWLIST", "")
	t.Setenv("PORTAL_ISSUER", "idp.example")
	if _, err := Load(); err == nil {
		t.Fatal("production must boot-fail on relative PORTAL_ISSUER")
	}

	t.Setenv("PORTAL_ISSUER", "urn:example:portal")
	if _, err := Load(); err == nil {
		t.Fatal("production must boot-fail on opaque PORTAL_ISSUER")
	}

	t.Setenv("APP_ENV", "development")
	t.Setenv("REQUIRE_TLS", "true")
	t.Setenv("PORTAL_ISSUER", "http://portal.example")
	if _, err := Load(); err == nil {
		t.Fatal("REQUIRE_TLS must boot-fail on http PORTAL_ISSUER")
	}
}

func TestLoadProductionAcceptsHTTPSIssuersAndEmptyAllowlist(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "production")
	t.Setenv("EMBED_ISSUER", "https://idp.example")
	t.Setenv("EMBED_ISSUER_ALLOWLIST", "https://host-b.example")
	t.Setenv("PORTAL_ISSUER", "https://portal.cp-ops.example")
	t.Setenv("PORTAL_ISSUER_ALLOWLIST", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.EmbedIssuers) != 2 || cfg.EmbedIssuers[0] != "https://host-b.example" || cfg.EmbedIssuers[1] != "https://idp.example" {
		t.Fatalf("embed issuers %v", cfg.EmbedIssuers)
	}
	if len(cfg.PortalIssuers) != 1 || cfg.PortalIssuers[0] != "https://portal.cp-ops.example" {
		t.Fatalf("portal issuers %v", cfg.PortalIssuers)
	}

	t.Setenv("EMBED_ISSUER", "")
	t.Setenv("EMBED_ISSUER_ALLOWLIST", "")
	t.Setenv("PORTAL_ISSUER", "")
	t.Setenv("PORTAL_ISSUER_ALLOWLIST", "")
	empty, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(empty.EmbedIssuers) != 0 || len(empty.PortalIssuers) != 0 {
		t.Fatalf("empty allowlists must still load (ADV-005 request-time 403), embed=%v portal=%v", empty.EmbedIssuers, empty.PortalIssuers)
	}
}

func TestLoadNonProductionAllowsHTTPIssuers(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", "")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("EMBED_ISSUER", "http://idp.example")
	t.Setenv("EMBED_ISSUER_ALLOWLIST", "")
	t.Setenv("PORTAL_ISSUER", "http://portal.example")
	t.Setenv("PORTAL_ISSUER_ALLOWLIST", "")

	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.EmbedIssuers) != 1 || cfg.EmbedIssuers[0] != "http://idp.example" {
		t.Fatalf("dev embed issuers %v", cfg.EmbedIssuers)
	}
	if len(cfg.PortalIssuers) != 1 || cfg.PortalIssuers[0] != "http://portal.example" {
		t.Fatalf("dev portal issuers %v", cfg.PortalIssuers)
	}
}

func TestLoadDevelopmentAllowsEphemeralSigningKey(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", "")
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.EmbedKeys.Ready() || !cfg.EmbedKeys.Ephemeral() {
		t.Fatalf("dev empty key should be ephemeral, ready=%v ephemeral=%v", cfg.EmbedKeys.Ready(), cfg.EmbedKeys.Ephemeral())
	}
}

func testEmbedSigningKey(t *testing.T) string {
	t.Helper()
	return embed.EncodePKCS8PEM(embed.TestMaterial().Private)
}

func TestLoadSeedLocalDefaultsGate(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
	t.Setenv("EMBED_SIGNING_KEY_FILE", "")
	t.Setenv("EMBED_AUDIENCE", "")
	t.Setenv("REQUIRE_TLS", "")
	t.Setenv("TRUSTED_DEV_IDENTITY_HEADERS", "")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv(localseed.EnvSeedLocalDefaults, "")

	t.Setenv("APP_ENV", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SeedLocalDefaults {
		t.Fatal("empty APP_ENV must not seed")
	}

	t.Setenv("APP_ENV", "production")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SeedLocalDefaults {
		t.Fatal("production must not seed")
	}

	t.Setenv(localseed.EnvSeedLocalDefaults, "1")
	if _, err := Load(); err == nil {
		t.Fatal("explicit seed in production must refuse to start")
	}

	t.Setenv(localseed.EnvSeedLocalDefaults, "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("REQUIRE_TLS", "true")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SeedLocalDefaults {
		t.Fatal("REQUIRE_TLS must not seed")
	}

	t.Setenv(localseed.EnvSeedLocalDefaults, "1")
	if _, err := Load(); err == nil {
		t.Fatal("explicit seed with REQUIRE_TLS must refuse to start")
	}

	t.Setenv("REQUIRE_TLS", "false")
	t.Setenv(localseed.EnvSeedLocalDefaults, "1")
	t.Setenv("EMBED_SIGNING_KEY", "")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.SeedLocalDefaults {
		t.Fatal("development + explicit seed must enable")
	}

	t.Setenv(localseed.EnvSeedLocalDefaults, "0")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SeedLocalDefaults {
		t.Fatal("explicit opt-out must disable seed")
	}
}

func TestLoadRejectsInvalidCredentialKEK(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
	t.Setenv("CREDENTIAL_KEK", "not-a-32-byte-key")
	t.Setenv("CREDENTIAL_KEK_FILE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected invalid CREDENTIAL_KEK error")
	}
}

func TestLoadTLSFilesMustBePaired(t *testing.T) {
	t.Setenv("EMBED_SIGNING_KEY", testEmbedSigningKey(t))
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
