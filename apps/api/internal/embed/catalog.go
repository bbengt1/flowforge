package embed

import "github.com/bbengt1/flowforge/apps/api/internal/authz"

// HookStatus describes an E11.2 surface that is not fully implemented.
type HookStatus struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Fail   string `json:"failClosed"`
	Note   string `json:"note"`
}

// Catalog is the versioned embed contract for host backends and Chloe.
type Catalog struct {
	SDK           string        `json:"sdk"`
	Algorithm     string        `json:"algorithm"`
	Audience      string        `json:"audience"`
	DefaultTTL    string        `json:"defaultTtl"`
	MinTTL        string        `json:"minTtl"`
	MaxTTL        string        `json:"maxTtl"`
	JTIRetention  string        `json:"jtiRetention"`
	MountPrefix   string        `json:"mountPrefix"`
	Claims        []ClaimDoc    `json:"claims"`
	Capabilities  []string      `json:"capabilities"`
	Routes        []Route       `json:"routes"`
	API           []APIRoute    `json:"api"`
	KeyManagement KeyManagement `json:"keyManagement"`
	Hooks         []HookStatus  `json:"hooks"`
	Rules         CatalogRules  `json:"rules"`
}

// ClaimDoc documents an assertion claim.
type ClaimDoc struct {
	Name     string `json:"name"`
	Required bool   `json:"required"`
	JSON     string `json:"json"`
	Note     string `json:"note"`
}

// APIRoute is a control-plane embed endpoint.
type APIRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Auth   string `json:"auth"`
	CSRF   string `json:"csrf"`
	Note   string `json:"note"`
}

// KeyManagement documents how hosts obtain and verify keys.
type KeyManagement struct {
	Algorithm     string   `json:"algorithm"`
	PublicJWKS    string   `json:"publicJwks"`
	PrivateNever  []string `json:"privateNeverReturned"`
	Env           []string `json:"env"`
	Rotation      string   `json:"rotation"`
	MaxOverlapTTL string   `json:"maxOverlapTtl"`
}

// CatalogRules are fail-closed product rules for the embed shell.
type CatalogRules struct {
	AssertionNotInURL            bool `json:"assertionNotInURL"`
	HostIDsNotAuthz              bool `json:"hostIdsAreNotAuthorization"`
	SingleUse                    bool `json:"singleUse"`
	AudienceBound                bool `json:"audienceBound"`
	AsymmetricSigned             bool `json:"asymmetricSigned"`
	StandaloneDeepLinksOK        bool `json:"standaloneDeepLinksRemainValid"`
	EmbedSessionsCannotBootstrap bool `json:"embedSessionsCannotBootstrap"`
	PartitionedEmbedCookies      bool `json:"partitionedEmbedCookies"`
	VerifyBeforeWorkspaceLookup  bool `json:"verifyBeforeWorkspaceLookup"`
	JTIRetainPastExpiry          bool `json:"jtiRetainPastExpiry"`
	AuthzAudited                 bool `json:"authzAudited"`
	ExchangeRateLimited          bool `json:"exchangeRateLimited"`
}

// NewCatalog builds the E11.1 + E11.2 contract document.
func NewCatalog() Catalog {
	return Catalog{
		SDK:          SDKVersion,
		Algorithm:    Algorithm,
		Audience:     DefaultAudience,
		DefaultTTL:   DefaultTTL.String(),
		MinTTL:       MinTTL.String(),
		MaxTTL:       MaxTTL.String(),
		JTIRetention: JTIRetention.String(),
		MountPrefix:  MountPrefix,
		Claims:       claimDocs(),
		Capabilities: authz.PermissionKeys(),
		Routes:       CanonicalRoutes(),
		API: []APIRoute{
			{Method: "GET", Path: "/api/v1/embed/catalog", Auth: "none", CSRF: "no", Note: "Versioned SDK/contract + route map for Chloe and host backends."},
			{Method: "GET", Path: "/api/v1/embed/jwks", Auth: "none", CSRF: "no", Note: "Public Ed25519 keys only. Never includes d / PEM / seed."},
			{Method: "POST", Path: "/api/v1/embed/assertions", Auth: "session or identity headers + workspace membership", CSRF: "yes when ff_session present", Note: "Host backend mint. Subject and issuer bind to the authenticated caller. A different subject requires embed.impersonate (PLATFORM_ADMINS); a different issuer is 403. Issuer must be on EMBED_ISSUER / EMBED_ISSUER_ALLOWLIST (empty fails closed, 403). Capabilities must be a subset of the caller. Audience is FlowForge."},
			{Method: "POST", Path: "/api/v1/embed/exchange", Auth: "assertion", CSRF: "no", Note: "Refresh overlap from the durable store, then verify signature/iss (merged embed+portal allowlist; empty fails closed, 403)/aud/nbf/exp/jti/capabilities before any workspace lookup. Refuse expired/retired overlap (overlapUntil). Atomically consume jti in one INSERT ON CONFLICT DO NOTHING RETURNING only after verify succeeds. Used jtis are retained 24h past assertion exp; purge is a separate job on retain_until. Then resolve (tenant_id, workbench_key) and bind onto ff_session with CHIPS cookies (SameSite=None; Secure; Partitioned). Invalid assertions fail closed the same way whether or not the tenant exists. Bound sessions cannot POST /tenants or /workspaces. Assertion is never accepted from a URL. A browser that does not send the partitioned cookie fails closed (401/403). Rate-limited by IP (default 120/min) and issuer|subject (default 30/min); burst is 429 rate-limited. Authz decisions emit secret-free audit events."},
			{Method: "POST", Path: "/api/v1/embed/keys/rotate", Auth: "session or identity headers + platform.administer (PLATFORM_ADMINS)", CSRF: "yes when ff_session present", Note: "Register the current active public JWK as overlap (overlapUntil required, max 4h), or retire an overlap kid. workspace.administer is not enough. Arbitrary Ed25519 keys are rejected. Mint stays on the durable active env key. The active key is not an overlap key and has no overlapUntil. Verify refreshes overlap and refuses missing/expired/far-future overlapUntil. Unknown kid fails closed."},
		},
		KeyManagement: KeyManagement{
			Algorithm:     Algorithm + " (" + Curve + ")",
			PublicJWKS:    "/api/v1/embed/jwks",
			PrivateNever:  []string{"d", "privateKey", "private_key", "seed", "pem", "EMBED_SIGNING_KEY"},
			Env:           []string{EnvSigningKey, EnvSigningKeyFile, EnvSigningKeyID, EnvAudience, EnvAssertionTTL, EnvIssuer, EnvIssuerAllow, EnvOverlapKeys, EnvExchangeRateLimitIP, EnvExchangeRateLimitPrincipal, EnvMintRateLimitPrincipal, EnvRateLimitWindow, authz.EnvPlatformAdmins, authz.EnvPlatformAdmin},
			MaxOverlapTTL: MaxOverlapTTL.String(),
			Rotation:      "Mint with the durable active EMBED_SIGNING_KEY (production boot-fails if unset). The active key is not an overlap key and does not use overlapUntil. JWKS publishes active + overlap after a store refresh. Every overlap verify key requires a short overlapUntil (max 4h). Missing, zero, or far-future is 400 on rotate or boot-fail on EMBED_OVERLAP_KEYS. Verify refreshes overlap and refuses missing/expired/retired/far-future kids. POST /embed/keys/rotate is platform-admin only and registers only the previous/current active public key as overlap. Unknown kid fails closed.",
		},
		Hooks: []HookStatus{
			{ID: "jti.consume", Status: "ready", Fail: "replayed jti is 409; store failure is 503", Note: "Single-statement Postgres INSERT … ON CONFLICT DO NOTHING RETURNING. Used ids retained 24h past assertion exp (retain_until). PurgeExpired is a separate job and must not delete at JWT exp. MemoryJTI remains for process-local tests."},
			{ID: "key.rotation", Status: "ready", Fail: "unknown kid fails closed; missing/zero/expired/far-future overlapUntil fails closed; overlap register of a non-prior-active key fails closed; workspace.administer cannot rotate; production missing EMBED_SIGNING_KEY is boot-fail; bad EMBED_OVERLAP_KEYS is boot-fail", Note: "Durable active signing key (EMBED_SIGNING_KEY) plus explicit overlap verification keys (env + rotate API + store). Every overlap key requires a short overlapUntil (max 4h). The active key is not an overlap-until-forever via a missing field. Verify refreshes overlap from the store and refuses missing/expired/retired/far-future keys. Rotate API accepts only the previous active public key and requires platform.administer."},
			{ID: "tenancy.propagation", Status: "ready", Fail: "host tenant is never authorization; header mismatch fails closed; embed sessions cannot bootstrap tenants or sibling workbenches", Note: "Embed sessions bind (tenant_id, workbench_key) and propagate through API authz, configuration, jobs, workers, caches, realtime, history, and audit. POST /tenants and POST /workspaces from an embed session are 403 even if the principal is a platform-admin. Exchange verifies the assertion before resolving tenant/workbench."},
			{ID: "assertion.verify-before-lookup", Status: "ready", Fail: "forged or invalid assertions fail closed without resolving tenant/workbench; same error class whether or not the workspace exists", Note: "POST /embed/exchange completes signature, audience, issuer allowlist, nbf/exp, and jti eligibility before any workspace or membership lookup. Durable jti consume runs only after verify succeeds. Tenancy bind happens after verify."},
			{ID: "portal.adapter", Status: "ready", Fail: "empty or hostile issuer allowlist, replay, cross-tenant/workbench, and credential/raw-log exposure fail closed", Note: "CP Ops Portal adapter. Portal RBAC is entry only. Mint uses embed.v1 (aud=flowforge). Empty PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST is 403. FlowForge never shares its database or executor."},
			{ID: "chips.embed-cookies", Status: "ready", Fail: "cross-site iframe without the partitioned cookie is 401 (cookie not sent) or 403 (CSRF cookie missing); SameSite=None without Partitioned is not used; top-level cookies stay Lax/Strict", Note: "Embed ff_session/ff_csrf after POST /embed/exchange are SameSite=None; Secure; Partitioned (CHIPS). Secure is never dropped. Standalone POST /session stays SameSite=Lax / Strict. HTTPS / a secure context is required. ADV-013 covers a full cross-origin host check."},
			{ID: "authz.audit", Status: "ready", Fail: "authz decisions emit secret-free audit; assertion plaintext, signing keys, and session secrets are never logged", Note: "Mint allow/deny (including impersonation), exchange allow/deny with reason codes, rotate allow/deny, capability and tenancy bind failures, and rate-limit denials write structured embed_audit events (jti, kid, issuer, subject, tenant_id, workbench_key, workspace_id, reason)."},
			{ID: "exchange.rate-limit", Status: "ready", Fail: "burst POST /embed/exchange is 429 rate-limited", Note: "Keyed by client IP (default 120/min) and issuer|subject when claims are peekable (default 30/min). Window default 1m. Configurable via EMBED_EXCHANGE_RATE_LIMIT_IP, EMBED_EXCHANGE_RATE_LIMIT_PRINCIPAL, EMBED_RATE_LIMIT_WINDOW. Mint may use EMBED_MINT_RATE_LIMIT_PRINCIPAL (default 60/min). Soft-deny with 429 + problem detail. A nil limiter fails closed."},
		},
		Rules: CatalogRules{
			AssertionNotInURL:            true,
			HostIDsNotAuthz:              true,
			SingleUse:                    true,
			AudienceBound:                true,
			AsymmetricSigned:             true,
			StandaloneDeepLinksOK:        true,
			EmbedSessionsCannotBootstrap: true,
			PartitionedEmbedCookies:      true,
			VerifyBeforeWorkspaceLookup:  true,
			JTIRetainPastExpiry:          true,
			AuthzAudited:                 true,
			ExchangeRateLimited:          true,
		},
	}
}

func claimDocs() []ClaimDoc {
	return []ClaimDoc{
		{Name: "iss", Required: true, JSON: "iss", Note: "Host issuer that minted via FlowForge (always the authenticated caller). Client-supplied issuer that differs is 403. Must be on EMBED_ISSUER / EMBED_ISSUER_ALLOWLIST (merged with Portal issuers on exchange). Empty allowlist fails closed."},
		{Name: "aud", Required: true, JSON: "aud", Note: "Must be flowforge. Wrong audience fails closed."},
		{Name: "sub", Required: true, JSON: "sub", Note: "End-user external subject. Bound to the minting caller unless the caller has embed.impersonate (PLATFORM_ADMINS)."},
		{Name: "nbf", Required: true, JSON: "nbf", Note: "Unix seconds. Not-yet-valid fails closed."},
		{Name: "exp", Required: true, JSON: "exp", Note: "Unix seconds. Short TTL (default 60s, max 5m)."},
		{Name: "jti", Required: true, JSON: "jti", Note: "Unique token id. Single-use. Atomic single-statement consume; used ids retained 24h past exp; replay is 409."},
		{Name: "tenant_id", Required: true, JSON: "tenant_id", Note: "Workspace identity half. Verified on the assertion before any store lookup, then bound onto the session. Host tenant is never authorization by itself."},
		{Name: "workbench_key", Required: true, JSON: "workbench_key", Note: "Workspace identity half with tenant_id. Verified before workspace lookup. Bound onto the session and required on later UI/API calls."},
		{Name: "workspace_id", Required: false, JSON: "workspace_id", Note: "Optional binding. Confirmed against server resolution after verify. Never the lookup key."},
		{Name: "capabilities", Required: true, JSON: "capabilities", Note: "FlowForge workspace permission keys. Mint requires a subset of the caller. platform.administer and embed.impersonate are never mintable."},
		{Name: "sdk", Required: true, JSON: "sdk", Note: "embed.v1"},
		{Name: "display_name", Required: false, JSON: "display_name", Note: "Display context until the API verifies the subject."},
		{Name: "host", Required: false, JSON: "host", Note: "Minting caller issuer. Set when minting for another subject (embed.impersonate)."},
	}
}
