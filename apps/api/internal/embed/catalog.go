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
	AssertionNotInURL     bool `json:"assertionNotInURL"`
	HostIDsNotAuthz       bool `json:"hostIdsAreNotAuthorization"`
	SingleUse             bool `json:"singleUse"`
	AudienceBound         bool `json:"audienceBound"`
	AsymmetricSigned      bool `json:"asymmetricSigned"`
	StandaloneDeepLinksOK bool `json:"standaloneDeepLinksRemainValid"`
}

// NewCatalog builds the E11.1 contract document.
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
			{Method: "POST", Path: "/api/v1/embed/exchange", Auth: "assertion", CSRF: "no", Note: "Validate + consume jti (in-process stub) and issue ff_session. Assertion is never accepted from a URL."},
		},
		KeyManagement: KeyManagement{
			Algorithm:    Algorithm + " (" + Curve + ")",
			PublicJWKS:   "/api/v1/embed/jwks",
			PrivateNever: []string{"d", "privateKey", "private_key", "seed", "pem", "EMBED_SIGNING_KEY"},
			Env:          []string{EnvSigningKey, EnvSigningKeyFile, EnvSigningKeyID, EnvAudience, EnvAssertionTTL, EnvIssuer},
			Rotation:     "E11.2: verify active + explicit overlap kids only. E11.1 signs/verifies the active key and leaves Overlap empty.",
		},
		Hooks: []HookStatus{
			{ID: "jti.consume", Status: "stub", Fail: "in-process MemoryJTI rejects replay; not durable across pods", Note: "E11.2 atomic Postgres consume with TTL."},
			{ID: "key.rotation", Status: "stub", Fail: "unknown kid fails closed", Note: "E11.2 active + overlap verification keys."},
			{ID: "tenancy.propagation", Status: "stub", Fail: "host tenant/workbench are context; authorization stays server-derived", Note: "E11.2 propagate (tenant_id, workbench_key) through UI, API, jobs, workers, caches, realtime, history, and audit."},
		},
		Rules: CatalogRules{
			AssertionNotInURL:     true,
			HostIDsNotAuthz:       true,
			SingleUse:             true,
			AudienceBound:         true,
			AsymmetricSigned:      true,
			StandaloneDeepLinksOK: true,
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
		{Name: "jti", Required: true, JSON: "jti", Note: "Unique token id. Single-use. E11.1 in-process consume; E11.2 atomic durable."},
		{Name: "tenant_id", Required: true, JSON: "tenant_id", Note: "Workspace identity half. Context, never authorization by itself."},
		{Name: "workbench_key", Required: true, JSON: "workbench_key", Note: "Workspace identity half with tenant_id."},
		{Name: "workspace_id", Required: false, JSON: "workspace_id", Note: "Optional binding. Must match server resolution. Never the lookup key."},
		{Name: "capabilities", Required: true, JSON: "capabilities", Note: "FlowForge permission keys. Mint requires a subset of the caller."},
		{Name: "sdk", Required: true, JSON: "sdk", Note: "embed.v1"},
		{Name: "display_name", Required: false, JSON: "display_name", Note: "Display context until the API verifies the subject."},
		{Name: "host", Required: false, JSON: "host", Note: "Minting caller issuer when minting for another subject."},
	}
}
