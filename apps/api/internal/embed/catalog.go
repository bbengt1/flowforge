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
	Algorithm    string   `json:"algorithm"`
	PublicJWKS   string   `json:"publicJwks"`
	PrivateNever []string `json:"privateNeverReturned"`
	Env          []string `json:"env"`
	Rotation     string   `json:"rotation"`
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
		MountPrefix:  MountPrefix,
		Claims:       claimDocs(),
		Capabilities: authz.PermissionKeys(),
		Routes:       CanonicalRoutes(),
		API: []APIRoute{
			{Method: "GET", Path: "/api/v1/embed/catalog", Auth: "none", CSRF: "no", Note: "Versioned SDK/contract + route map for Chloe and host backends."},
			{Method: "GET", Path: "/api/v1/embed/jwks", Auth: "none", CSRF: "no", Note: "Public Ed25519 keys only. Never includes d / PEM / seed."},
			{Method: "POST", Path: "/api/v1/embed/assertions", Auth: "session or identity headers + workspace membership", CSRF: "yes when ff_session present", Note: "Host backend mint. Capabilities must be a subset of the caller. Audience is FlowForge."},
			{Method: "POST", Path: "/api/v1/embed/exchange", Auth: "assertion", CSRF: "no", Note: "Validate iss/aud/nbf/exp/jti/capabilities/workspace, atomically consume jti (Postgres TTL), bind (tenant_id, workbench_key) onto ff_session. Bound sessions cannot POST /tenants or /workspaces. Assertion is never accepted from a URL."},
			{Method: "POST", Path: "/api/v1/embed/keys/rotate", Auth: "session or identity headers + platform.administer (PLATFORM_ADMINS)", CSRF: "yes when ff_session present", Note: "Register the current active public JWK as overlap, or retire an overlap kid. workspace.administer is not enough. Arbitrary Ed25519 keys are rejected. Mint stays on the active env key. Unknown kid fails closed."},
		},
		KeyManagement: KeyManagement{
			Algorithm:    Algorithm + " (" + Curve + ")",
			PublicJWKS:   "/api/v1/embed/jwks",
			PrivateNever: []string{"d", "privateKey", "private_key", "seed", "pem", "EMBED_SIGNING_KEY"},
			Env:          []string{EnvSigningKey, EnvSigningKeyFile, EnvSigningKeyID, EnvAudience, EnvAssertionTTL, EnvIssuer, EnvIssuerAllow, EnvOverlapKeys, authz.EnvPlatformAdmins, authz.EnvPlatformAdmin},
			Rotation:     "Mint with the active EMBED_SIGNING_KEY. JWKS publishes active + overlap. Verify accepts overlap-window kids. POST /embed/keys/rotate is platform-admin only and registers only the previous/current active public key as overlap. Unknown kid fails closed.",
		},
		Hooks: []HookStatus{
			{ID: "jti.consume", Status: "ready", Fail: "replayed jti is 409; store failure is 503", Note: "Atomic Postgres INSERT ON CONFLICT with TTL. MemoryJTI remains for process-local tests."},
			{ID: "key.rotation", Status: "ready", Fail: "unknown kid fails closed; overlap register of a non-prior-active key fails closed; workspace.administer cannot rotate", Note: "Active signing key plus explicit overlap verification keys (env + rotate API). Rotate API accepts only the previous active public key and requires platform.administer."},
			{ID: "tenancy.propagation", Status: "ready", Fail: "host tenant is never authorization; header mismatch fails closed; embed sessions cannot bootstrap tenants or sibling workbenches", Note: "Embed sessions bind (tenant_id, workbench_key) and propagate through API authz, configuration, jobs, workers, caches, realtime, history, and audit. POST /tenants and POST /workspaces from an embed session are 403 even if the principal is a platform-admin."},
			{ID: "portal.adapter", Status: "ready", Fail: "hostile host, replay, cross-tenant/workbench, and credential/raw-log exposure fail closed", Note: "CP Ops Portal adapter. Portal RBAC is entry only. Mint uses embed.v1 (aud=flowforge). FlowForge never shares its database or executor."},
		},
		Rules: CatalogRules{
			AssertionNotInURL:            true,
			HostIDsNotAuthz:              true,
			SingleUse:                    true,
			AudienceBound:                true,
			AsymmetricSigned:             true,
			StandaloneDeepLinksOK:        true,
			EmbedSessionsCannotBootstrap: true,
		},
	}
}

func claimDocs() []ClaimDoc {
	return []ClaimDoc{
		{Name: "iss", Required: true, JSON: "iss", Note: "Host issuer that minted via FlowForge (caller issuer)."},
		{Name: "aud", Required: true, JSON: "aud", Note: "Must be flowforge. Wrong audience fails closed."},
		{Name: "sub", Required: true, JSON: "sub", Note: "End-user external subject."},
		{Name: "nbf", Required: true, JSON: "nbf", Note: "Unix seconds. Not-yet-valid fails closed."},
		{Name: "exp", Required: true, JSON: "exp", Note: "Unix seconds. Short TTL (default 60s, max 5m)."},
		{Name: "jti", Required: true, JSON: "jti", Note: "Unique token id. Single-use. Atomic durable consume with TTL; replay is 409."},
		{Name: "tenant_id", Required: true, JSON: "tenant_id", Note: "Workspace identity half. Bound onto the session. Host tenant is never authorization by itself."},
		{Name: "workbench_key", Required: true, JSON: "workbench_key", Note: "Workspace identity half with tenant_id. Bound onto the session and required on later UI/API calls."},
		{Name: "workspace_id", Required: false, JSON: "workspace_id", Note: "Optional binding. Must match server resolution. Never the lookup key."},
		{Name: "capabilities", Required: true, JSON: "capabilities", Note: "FlowForge workspace permission keys. Mint requires a subset of the caller. platform.administer is never mintable."},
		{Name: "sdk", Required: true, JSON: "sdk", Note: "embed.v1"},
		{Name: "display_name", Required: false, JSON: "display_name", Note: "Display context until the API verifies the subject."},
		{Name: "host", Required: false, JSON: "host", Note: "Minting caller issuer when minting for another subject."},
	}
}
