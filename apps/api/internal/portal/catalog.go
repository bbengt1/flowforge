package portal

import (
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
)

// APIRoute is a Portal-facing or reused embed endpoint.
type APIRoute struct {
	Method string `json:"method"`
	Path   string `json:"path"`
	Auth   string `json:"auth"`
	CSRF   string `json:"csrf"`
	Note   string `json:"note"`
}

// Catalog is the versioned Portal adapter contract for Chloe and the host.
type Catalog struct {
	Adapter        string        `json:"adapter"`
	SDK            string        `json:"sdk"`
	Audience       string        `json:"audience"`
	Algorithm      string        `json:"algorithm"`
	MountPrefix    string        `json:"mountPrefix"`
	EntryPath      string        `json:"entryPath"`
	Boundary       Boundary      `json:"boundary"`
	Wiring         []HostStep    `json:"hostWiring"`
	CapabilityMap  []RoleBinding `json:"capabilityMap"`
	Capabilities   []string      `json:"capabilities"`
	Routes         []embed.Route `json:"routes"`
	API            []APIRoute    `json:"api"`
	Env            []string      `json:"env"`
	Issuers        []string      `json:"issuers"`
	FrameAncestors []string      `json:"frameAncestors"`
	Rules          CatalogRules  `json:"rules"`
}

// CatalogRules are fail-closed product rules for the Portal host.
type CatalogRules struct {
	PortalEntryIsNotAuthz         bool `json:"portalEntryIsNotAuthorization"`
	MustUseEmbedMint              bool `json:"mustUseEmbedMint"`
	MustUseEmbedExchange          bool `json:"mustUseEmbedExchange"`
	AssertionNotInURL             bool `json:"assertionNotInURL"`
	HostIDsNotAuthz               bool `json:"hostIdsAreNotAuthorization"`
	NoDatabaseShare               bool `json:"noDatabaseShare"`
	NoExecutorShare               bool `json:"noExecutorShare"`
	NoCredentialOrRawLogLeak      bool `json:"noCredentialOrRawLogExposure"`
	FrameAncestorsExactOrigin     bool `json:"frameAncestorsExactOrigin"`
	EmbedSessionsCannotBootstrap  bool `json:"embedSessionsCannotBootstrap"`
	PortalAdminIsNotPlatformAdmin bool `json:"portalAdminIsNotPlatformAdmin"`
	PartitionedEmbedCookies       bool `json:"partitionedEmbedCookies"`
	SharedHostAllowlist           bool `json:"sharedHostAllowlist"`
	EmptyHostAllowlistFailsClosed bool `json:"emptyHostAllowlistFailsClosed"`
	PostMessageUsesFrameAncestors bool `json:"postMessageUsesFrameAncestors"`
}

// NewCatalog builds the E11.3 contract. Issuers and frame ancestors are
// the configured allowlists (empty issuer lists fail closed at mint).
func NewCatalog(issuers, frames []string) Catalog {
	return Catalog{
		Adapter:        AdapterVersion,
		SDK:            EmbedSDK,
		Audience:       Audience,
		Algorithm:      embed.Algorithm,
		MountPrefix:    MountPrefix,
		EntryPath:      EntryPath,
		Boundary:       DefaultBoundary(),
		Wiring:         HostWiring(),
		CapabilityMap:  CapabilityMap(),
		Capabilities:   authz.PermissionKeys(),
		Routes:         embed.CanonicalRoutes(),
		API:            adapterAPI(),
		Env:            []string{EnvIssuer, EnvIssuerAllow, EnvFrameAllow, EnvWebFrameAllow, embed.EnvIssuer, embed.EnvIssuerAllow, embed.EnvWebEmbedFrames},
		Issuers:        append([]string(nil), issuers...),
		FrameAncestors: append([]string(nil), frames...),
		Rules: CatalogRules{
			PortalEntryIsNotAuthz:         true,
			MustUseEmbedMint:              true,
			MustUseEmbedExchange:          true,
			AssertionNotInURL:             true,
			HostIDsNotAuthz:               true,
			NoDatabaseShare:               true,
			NoExecutorShare:               true,
			NoCredentialOrRawLogLeak:      true,
			FrameAncestorsExactOrigin:     true,
			EmbedSessionsCannotBootstrap:  true,
			PortalAdminIsNotPlatformAdmin: true,
			PartitionedEmbedCookies:       true,
			SharedHostAllowlist:           true,
			EmptyHostAllowlistFailsClosed: true,
			PostMessageUsesFrameAncestors: true,
		},
	}
}

func adapterAPI() []APIRoute {
	return []APIRoute{
		{Method: "GET", Path: "/api/v1/portal/adapter", Auth: "none", CSRF: "no", Note: "Versioned Portal adapter contract, capability map, and host wiring for Chloe. frameAncestors is the shared host allowlist (same merge as GET /embed/catalog) for CSP and postMessage."},
		{Method: "POST", Path: "/api/v1/portal/adapter/assertions", Auth: "session or identity headers + workspace membership", CSRF: "yes when ff_session present", Note: "Portal-backend mint after Portal RBAC. Maps portalRoles → FlowForge capabilities, requires a non-empty PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST (empty fails closed, 403), then signs with E11.1 embed.Mint (aud=flowforge). Subject binds to the caller unless embed.impersonate (PLATFORM_ADMINS). Client issuer that differs from the caller is 403."},
		{Method: "POST", Path: "/api/v1/embed/assertions", Auth: "session or identity headers + workspace membership", CSRF: "yes when ff_session present", Note: "Same mint without role mapping. Subject/issuer bind to the caller unless embed.impersonate. Portal may call this directly after mapping roles client-side."},
		{Method: "POST", Path: "/api/v1/embed/exchange", Auth: "assertion", CSRF: "no", Note: "E11.1/E11.2 exchange. Not a Portal-specific path. Signature/claims verify before any workspace lookup. Replay 409. Binds (tenant_id, workbench_key) onto CHIPS cookies (SameSite=None; Secure; Partitioned). Bound sessions cannot create tenants or sibling workbenches. Cookie not sent is 401/403."},
		{Method: "GET", Path: "/api/v1/embed/catalog", Auth: "none", CSRF: "no", Note: "Embed SDK/contract. Portal adapter builds on this."},
		{Method: "GET", Path: "/api/v1/embed/jwks", Auth: "none", CSRF: "no", Note: "Public Ed25519 keys only."},
	}
}
