package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/artifact"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/portal"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const (
	defaultHTTPAddr        = ":8080"
	defaultPGHost          = "localhost"
	defaultPGPort          = "5432"
	defaultPGUser          = "flowforge"
	defaultPGDB            = "flowforge"
	defaultSSLMode         = "disable"
	defaultMigrateTimeout  = 5 * time.Minute
	defaultShutdownTimeout = 10 * time.Second
)

// Config is process configuration loaded from the environment.
type Config struct {
	HTTPAddr       string
	DatabaseURL    string
	ShutdownWait   time.Duration
	MigrateTimeout time.Duration
	// TrustedProxies are CIDRs allowed to set X-Forwarded-Proto / X-Forwarded-For.
	// Empty means forwarded headers are ignored (safe local default).
	TrustedProxies []*net.IPNet
	// RequireTLS rejects requests that are not HTTPS (direct TLS or a trusted proxy).
	RequireTLS  bool
	TLSCertFile string
	TLSKeyFile  string
	// CORSAllowedOrigins is an exact allowlist. Empty is fail-closed for
	// cross-origin browser calls. Wildcard origins are rejected at load.
	CORSAllowedOrigins     []string
	SessionIdleTimeout     time.Duration
	SessionAbsoluteTimeout time.Duration
	// VaultKeys is the local envelope KEK loaded from CREDENTIAL_KEK /
	// CREDENTIAL_KEK_FILE. Empty keys fail closed on vault write/unlock.
	VaultKeys vault.Keys
	// ArtifactStoreDir is the local MVP filesystem root for encrypted
	// object payloads. Empty uses in-process memory storage.
	ArtifactStoreDir string
	// ArtifactDownloadTTL is the lifetime of a short-lived download grant.
	ArtifactDownloadTTL time.Duration
	// ArtifactMaxBytes is the upload size cap (logs use a tighter bound).
	ArtifactMaxBytes int
	// IntegrationActionsEnabled catalogs and executes http.request /
	// notification.* when the negative suite is present (default true).
	IntegrationActionsEnabled bool
	// EmbedKeys is the Ed25519 material used to mint/verify embed
	// assertions. Empty env yields an ephemeral process key.
	EmbedKeys            embed.Material
	EmbedAudience        string
	EmbedTTL             time.Duration
	EmbedIssuer          string
	EmbedIssuers         []string
	PortalIssuers        []string
	PortalFrameAncestors []string
}

// Load reads configuration from the process environment.
// A .env file in the working directory (or the API module root) is loaded
// first when present; existing environment variables always win.
func Load() (Config, error) {
	loadDotEnv()

	proxies, err := parseCIDRs(os.Getenv("TRUSTED_PROXY_CIDRS"))
	if err != nil {
		return Config{}, fmt.Errorf("TRUSTED_PROXY_CIDRS: %w", err)
	}
	origins, err := parseOrigins(os.Getenv("CORS_ALLOWED_ORIGINS"))
	if err != nil {
		return Config{}, fmt.Errorf("CORS_ALLOWED_ORIGINS: %w", err)
	}
	keys, err := vault.LoadKeys()
	if err != nil {
		return Config{}, err
	}
	embedKeys, err := embed.LoadMaterial()
	if err != nil {
		return Config{}, err
	}

	cfg := Config{
		HTTPAddr:                  listenAddr(),
		DatabaseURL:               databaseURL(),
		ShutdownWait:              durationEnv("SHUTDOWN_TIMEOUT", defaultShutdownTimeout),
		MigrateTimeout:            durationEnv("MIGRATE_TIMEOUT", defaultMigrateTimeout),
		TrustedProxies:            proxies,
		RequireTLS:                boolEnv("REQUIRE_TLS", false),
		TLSCertFile:               strings.TrimSpace(os.Getenv("TLS_CERT_FILE")),
		TLSKeyFile:                strings.TrimSpace(os.Getenv("TLS_KEY_FILE")),
		CORSAllowedOrigins:        origins,
		SessionIdleTimeout:        durationEnv("SESSION_IDLE_TIMEOUT", 30*time.Minute),
		SessionAbsoluteTimeout:    durationEnv("SESSION_ABSOLUTE_TIMEOUT", 12*time.Hour),
		VaultKeys:                 keys,
		ArtifactStoreDir:          strings.TrimSpace(os.Getenv("ARTIFACT_STORE_DIR")),
		ArtifactDownloadTTL:       durationEnv("ARTIFACT_DOWNLOAD_TTL", wfstore.DefaultDownloadTTL),
		ArtifactMaxBytes:          intEnv("ARTIFACT_MAX_BYTES", artifact.DefaultMaxBytes),
		IntegrationActionsEnabled: boolEnv("INTEGRATION_ACTIONS_ENABLED", true),
		EmbedKeys:                 embedKeys,
		EmbedAudience:             firstNonEmpty(os.Getenv("EMBED_AUDIENCE"), embed.DefaultAudience),
		EmbedTTL:                  durationEnv("EMBED_ASSERTION_TTL", embed.DefaultTTL),
		EmbedIssuer:               strings.TrimSpace(os.Getenv("EMBED_ISSUER")),
		EmbedIssuers:              embed.ParseIssuerAllowlist(os.Getenv(embed.EnvIssuerAllow), os.Getenv(embed.EnvIssuer)),
		PortalIssuers:             portal.ParseIssuers(os.Getenv(portal.EnvIssuerAllow), os.Getenv(portal.EnvIssuer)),
		PortalFrameAncestors:      portal.ParseFrameAncestors(os.Getenv(portal.EnvFrameAllow)),
	}
	if cfg.HTTPAddr == "" {
		return Config{}, fmt.Errorf("HTTP_ADDR / PORT is empty")
	}
	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return Config{}, fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE must be set together")
	}
	if cfg.SessionIdleTimeout > cfg.SessionAbsoluteTimeout {
		cfg.SessionIdleTimeout = cfg.SessionAbsoluteTimeout
	}
	if cfg.EmbedTTL < embed.MinTTL || cfg.EmbedTTL > embed.MaxTTL {
		cfg.EmbedTTL = embed.DefaultTTL
	}
	if cfg.EmbedAudience != embed.DefaultAudience {
		return Config{}, fmt.Errorf("EMBED_AUDIENCE must be %q", embed.DefaultAudience)
	}
	return cfg, nil
}

// parseOrigins parses a comma-separated exact Origin allowlist.
// Empty input is valid (fail closed). Wildcard and null origins are rejected.
func parseOrigins(raw string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var out []string
	seen := map[string]struct{}{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if part == "*" || strings.EqualFold(part, "null") {
			return nil, fmt.Errorf("wildcard CORS origins are not allowed")
		}
		u, err := url.Parse(part)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("invalid CORS origin %q", part)
		}
		if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("invalid CORS origin %q", part)
		}
		if u.Path != "" && u.Path != "/" {
			return nil, fmt.Errorf("invalid CORS origin %q", part)
		}
		origin := u.Scheme + "://" + u.Host
		if _, ok := seen[origin]; ok {
			continue
		}
		seen[origin] = struct{}{}
		out = append(out, origin)
	}
	return out, nil
}

// parseCIDRs parses a comma-separated list of CIDRs. Empty input is valid.
func parseCIDRs(raw string) ([]*net.IPNet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var nets []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil {
				if ip.To4() != nil {
					part += "/32"
				} else {
					part += "/128"
				}
			}
		}
		_, network, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("invalid CIDR %q", part)
		}
		nets = append(nets, network)
	}
	return nets, nil
}

func boolEnv(name string, fallback bool) bool {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func listenAddr() string {
	if addr := strings.TrimSpace(os.Getenv("HTTP_ADDR")); addr != "" {
		return addr
	}
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		if strings.Contains(port, ":") {
			return port
		}
		return ":" + port
	}
	return defaultHTTPAddr
}

func databaseURL() string {
	if raw := strings.TrimSpace(os.Getenv("DATABASE_URL")); raw != "" {
		return raw
	}

	host := firstNonEmpty(os.Getenv("POSTGRES_HOST"), os.Getenv("PGHOST"), defaultPGHost)
	port := firstNonEmpty(os.Getenv("POSTGRES_PORT"), os.Getenv("PGPORT"), defaultPGPort)
	user := firstNonEmpty(os.Getenv("POSTGRES_USER"), os.Getenv("PGUSER"), defaultPGUser)
	pass := firstNonEmpty(os.Getenv("POSTGRES_PASSWORD"), os.Getenv("PGPASSWORD"))
	name := firstNonEmpty(os.Getenv("POSTGRES_DB"), os.Getenv("PGDATABASE"), defaultPGDB)
	ssl := firstNonEmpty(os.Getenv("POSTGRES_SSLMODE"), os.Getenv("PGSSLMODE"), defaultSSLMode)

	u := &url.URL{
		Scheme: "postgres",
		Host:   host + ":" + port,
		Path:   "/" + name,
	}
	if pass != "" {
		u.User = url.UserPassword(user, pass)
	} else {
		u.User = url.User(user)
	}
	q := u.Query()
	q.Set("sslmode", ssl)
	u.RawQuery = q.Encode()
	return u.String()
}

func intEnv(name string, fallback int) int {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return fallback
	}
	return n
}

func durationEnv(name string, fallback time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		return fallback
	}
	return d
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func loadDotEnv() {
	candidates := []string{".env"}
	if exe, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Join(filepath.Dir(exe), ".env"))
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "apps", "api", ".env"))
	}
	seen := map[string]struct{}{}
	for _, path := range candidates {
		abs, err := filepath.Abs(path)
		if err != nil {
			continue
		}
		if _, ok := seen[abs]; ok {
			continue
		}
		seen[abs] = struct{}{}
		applyDotEnvFile(abs)
	}
}

func applyDotEnvFile(path string) {
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		value = strings.TrimSpace(value)
		if len(value) >= 2 {
			if q := value[0]; (q == '"' || q == '\'') && value[len(value)-1] == q {
				value = value[1 : len(value)-1]
			}
		}
		_ = os.Setenv(key, value)
	}
}
