package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
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

	cfg := Config{
		HTTPAddr:       listenAddr(),
		DatabaseURL:    databaseURL(),
		ShutdownWait:   durationEnv("SHUTDOWN_TIMEOUT", defaultShutdownTimeout),
		MigrateTimeout: durationEnv("MIGRATE_TIMEOUT", defaultMigrateTimeout),
		TrustedProxies: proxies,
		RequireTLS:     boolEnv("REQUIRE_TLS", false),
		TLSCertFile:    strings.TrimSpace(os.Getenv("TLS_CERT_FILE")),
		TLSKeyFile:     strings.TrimSpace(os.Getenv("TLS_KEY_FILE")),
	}
	if cfg.HTTPAddr == "" {
		return Config{}, fmt.Errorf("HTTP_ADDR / PORT is empty")
	}
	if (cfg.TLSCertFile == "") != (cfg.TLSKeyFile == "") {
		return Config{}, fmt.Errorf("TLS_CERT_FILE and TLS_KEY_FILE must be set together")
	}
	return cfg, nil
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
