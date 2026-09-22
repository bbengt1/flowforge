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
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/lockout"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/mfa"
	"github.com/bbengt1/flowforge/apps/api/internal/oidc"
	"github.com/bbengt1/flowforge/apps/api/internal/portal"
	"github.com/bbengt1/flowforge/apps/api/internal/scheduler"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/scripts"
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
	// JobBindingKey is the 32-byte HMAC for worker job tickets
	// (JOB_BINDING_SECRET). Missing or malformed is a boot-fail.
	JobBindingKey []byte
	// ScriptSigningKey is the 32-byte HMAC for script artifact
	// signatures (SCRIPT_SIGNING_KEY). Missing or malformed is a boot-fail.
	ScriptSigningKey []byte
	// ArtifactStoreDir is the non-production filesystem root for encrypted
	// object payloads. Empty uses in-process memory. Ignored when
	// ArtifactS3 is enabled. A production-locked process refuses both.
	ArtifactStoreDir string
	// ArtifactS3 is the durable S3-compatible object store. Enabled is
	// false when no ARTIFACT_S3_* intent is set. Secret fields must not
	// be logged.
	ArtifactS3 artifact.S3Config
	// ArtifactDownloadTTL is the lifetime of a short-lived download grant.
	ArtifactDownloadTTL time.Duration
	// ArtifactMaxBytes is the upload size cap (logs use a tighter bound).
	ArtifactMaxBytes int
	// IntegrationActionsEnabled catalogs and executes http.request /
	// notification.* when the negative suite is present (default true).
	IntegrationActionsEnabled bool
	// EmbedKeys is the Ed25519 material used to mint/verify embed
	// assertions. Preferred source is PKCS#8 PEM (ADV-022). Production
	// requires EMBED_SIGNING_KEY (boot-fail). Non-production APP_ENV may
	// use a crypto/rand ephemeral process key.
	EmbedKeys     embed.Material
	EmbedAudience string
	EmbedTTL      time.Duration
	EmbedIssuer   string
	// EmbedIssuers is EMBED_ISSUER + EMBED_ISSUER_ALLOWLIST. Empty is
	// fail-closed at embed mint and (when Portal is also empty) exchange.
	// Production-locked processes require every configured issuer to be
	// an absolute https URI (ADV-018; boot-fail).
	EmbedIssuers []string
	// PortalIssuers is PORTAL_ISSUER + PORTAL_ISSUER_ALLOWLIST. Empty is
	// fail-closed at Portal mint. Merged into embed exchange verification.
	// Production-locked processes require every configured issuer to be
	// an absolute https URI (ADV-018; boot-fail).
	PortalIssuers []string
	// PortalFrameAncestors is the shared host allowlist (ADV-011):
	// PORTAL_FRAME_ANCESTORS ∪ WEB_PORTAL_FRAME_ANCESTORS ∪
	// WEB_EMBED_FRAME_ANCESTORS. Published on embed + Portal catalogs.
	// Empty fails closed (CSP 'none', no open postMessage).
	PortalFrameAncestors []string
	PlatformAdmins       []authz.PrincipalRef
	// EmbedLimits rate-limits POST /embed/exchange (required) and mint.
	EmbedLimits embed.Limits
	// LoginLimits rate-limits POST /login before bcrypt. Separate from
	// embed exchange so those IP budgets do not share a counter.
	LoginLimits localauth.Limits
	// EmbedNBFLeeway is clock-skew for embed assertion nbf only (ADV-017).
	// Default 30s, hard max 60s. exp is not given this leeway.
	EmbedNBFLeeway time.Duration
	// AppEnv is APP_ENV / FLOWFORGE_ENV. Empty is treated as production.
	AppEnv string
	// TrustIdentityHeaders is true only when TRUSTED_DEV_IDENTITY_HEADERS
	// is explicit and the process is not production-locked.
	TrustIdentityHeaders bool
	// SeedLocalDefaults is true for local/dev/test compose when
	// SEED_LOCAL_DEFAULTS is not an explicit off value. Production-locked
	// processes stay false; an explicit on flag is a boot-fail.
	SeedLocalDefaults bool
	// PublicBaseURL is the operator-facing origin (B.4). Localseed
	// persists it on trusted-dev skip. Never returned by GET /bootstrap.
	PublicBaseURL string
	// SchedulerEnabled runs the in-process leader (dispatch, recover,
	// purge). Empty SCHEDULER_ENABLED defaults on. Only the advisory-lock
	// holder ticks, so multiple API replicas stay safe.
	SchedulerEnabled bool
	// SchedulerInterval is the leader tick period.
	SchedulerInterval time.Duration
	// MachineConsumers names automation callers that require a live
	// machine principal. Empty does not change boot.
	MachineConsumers machine.Consumers
	// OIDC is opt-in. Partial OIDC_* config is a boot-fail. All empty
	// leaves the routes fail-closed when called.
	OIDC oidc.Settings
	// MFAKey encrypts TOTP secrets. Empty does not change boot.
	// Malformed MFA_SECRET_KEY is a boot-fail.
	MFAKey []byte
	// SCIM is opt-in. Partial SCIM_* config is a boot-fail. All empty
	// leaves /scim/v2 fail-closed when called. The bearer is not logged.
	SCIM scim.Settings
	// LockoutMaxFailures is the durable local-login failure threshold.
	LockoutMaxFailures int
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
	jobKey, err := wfstore.LoadJobBindingKey()
	if err != nil {
		return Config{}, err
	}
	scriptKey, err := scripts.LoadSigningKey()
	if err != nil {
		return Config{}, err
	}
	s3cfg, err := artifact.ParseS3FromEnv()
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
		JobBindingKey:             jobKey,
		ScriptSigningKey:          scriptKey,
		ArtifactStoreDir:          strings.TrimSpace(os.Getenv("ARTIFACT_STORE_DIR")),
		ArtifactS3:                s3cfg,
		ArtifactDownloadTTL:       durationEnv("ARTIFACT_DOWNLOAD_TTL", wfstore.DefaultDownloadTTL),
		ArtifactMaxBytes:          intEnv("ARTIFACT_MAX_BYTES", artifact.DefaultMaxBytes),
		IntegrationActionsEnabled: boolEnv("INTEGRATION_ACTIONS_ENABLED", true),
		EmbedKeys:                 embedKeys,
		EmbedAudience:             firstNonEmpty(os.Getenv("EMBED_AUDIENCE"), embed.DefaultAudience),
		EmbedTTL:                  durationEnv("EMBED_ASSERTION_TTL", embed.DefaultTTL),
		EmbedIssuer:               strings.TrimSpace(os.Getenv("EMBED_ISSUER")),
		EmbedIssuers:              embed.ParseIssuerAllowlist(os.Getenv(embed.EnvIssuerAllow), os.Getenv(embed.EnvIssuer)),
		PortalIssuers:             portal.ParseIssuers(os.Getenv(portal.EnvIssuerAllow), os.Getenv(portal.EnvIssuer)),
		PortalFrameAncestors: portal.MergeFrameAncestors(
			os.Getenv(portal.EnvFrameAllow),
			os.Getenv(portal.EnvWebFrameAllow),
			os.Getenv(embed.EnvWebEmbedFrames),
		),
		PlatformAdmins: authz.ParsePlatformAdmins(os.Getenv(authz.EnvPlatformAdmins), os.Getenv(authz.EnvPlatformAdmin)),
		EmbedLimits:    embed.LoadLimits(),
		LoginLimits:    localauth.LoadLimits(),
		EmbedNBFLeeway: embed.LoadNBFLeeway(),
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
	appEnv := firstNonEmpty(os.Getenv(authz.EnvAppEnv), os.Getenv(authz.EnvFlowforgeEnv))
	trustHeaders, err := authz.ResolveTrustedDevIdentityHeaders(os.Getenv(authz.EnvTrustedDevIdentityHeaders), appEnv, cfg.RequireTLS)
	if err != nil {
		return Config{}, err
	}
	cfg.AppEnv = appEnv
	cfg.TrustIdentityHeaders = trustHeaders
	seedLocal, err := localseed.Resolve(os.Getenv(localseed.EnvSeedLocalDefaults), appEnv, cfg.RequireTLS)
	if err != nil {
		return Config{}, err
	}
	cfg.SeedLocalDefaults = seedLocal
	publicURL, err := bootstrap.NormalizePublicBaseURL(os.Getenv(bootstrap.EnvPublicBaseURL))
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", bootstrap.EnvPublicBaseURL, err)
	}
	cfg.PublicBaseURL = publicURL
	requireHTTPS := authz.ProductionLocked(appEnv, cfg.RequireTLS)
	if err := embed.ValidateIssuerAllowlist(cfg.EmbedIssuers, requireHTTPS); err != nil {
		return Config{}, fmt.Errorf("%s / %s: %w", embed.EnvIssuer, embed.EnvIssuerAllow, err)
	}
	if err := embed.ValidateIssuerAllowlist(cfg.PortalIssuers, requireHTTPS); err != nil {
		return Config{}, fmt.Errorf("%s / %s: %w", portal.EnvIssuer, portal.EnvIssuerAllow, err)
	}
	schedOn, err := scheduler.EnabledFromEnv(os.Getenv(scheduler.EnvEnabled))
	if err != nil {
		return Config{}, err
	}
	schedEvery, err := scheduler.IntervalFromEnv(os.Getenv(scheduler.EnvInterval))
	if err != nil {
		return Config{}, err
	}
	cfg.SchedulerEnabled = schedOn
	cfg.SchedulerInterval = schedEvery
	consumers, err := machine.ParseConsumers(
		os.Getenv(machine.EnvRequire),
		os.Getenv(machine.EnvMetricsClientID),
		os.Getenv(machine.EnvSchedulerClientID),
		os.Getenv(machine.EnvAutomationClientID),
	)
	if err != nil {
		return Config{}, err
	}
	cfg.MachineConsumers = consumers
	oidcSettings, err := oidc.Load(requireHTTPS)
	if err != nil {
		return Config{}, err
	}
	cfg.OIDC = oidcSettings
	scimSettings, err := scim.Load(requireHTTPS, oidcSettings.Issuer)
	if err != nil {
		return Config{}, err
	}
	cfg.SCIM = scimSettings
	lockMax, err := lockout.LoadMaxFailures()
	if err != nil {
		return Config{}, err
	}
	cfg.LockoutMaxFailures = lockMax
	mfaKey, err := mfa.LoadKey()
	if err != nil {
		return Config{}, err
	}
	cfg.MFAKey = mfaKey
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
