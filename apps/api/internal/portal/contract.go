// Package portal is the FlowForge-side CP Ops Portal adapter (E11.3).
//
// Portal keeps its own entry RBAC and never shares the FlowForge database
// or executor. After Portal authorizes entry, its backend mints a short-lived
// embed.v1 assertion through the E11.1 mint path (audience flowforge,
// portal issuer, mapped capabilities, tenant, workbench). FlowForge then
// validates and authorizes independently (E11.2).
package portal

import (
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/embed"
)

const (
	// AdapterVersion is the versioned Portal adapter contract.
	AdapterVersion = "portal.v1"
	// DefaultIssuerExample is documentation-only. Production must set
	// PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST. Never used as a fallback iss.
	DefaultIssuerExample = "https://portal.cp-ops.example"
	// EntryPath is the documented Portal add-in entry (host-owned).
	EntryPath = "/portal/workflows"
	// EmbedSDK is the E11.1 SDK the adapter builds on. Not a parallel path.
	EmbedSDK = embed.SDKVersion
	// Audience is always FlowForge. Portal is not a second audience.
	Audience = embed.DefaultAudience
	// MountPrefix is the canonical embed mount Chloe already owns.
	MountPrefix = embed.MountPrefix
)

// Environment sources for the Portal integration boundary.
const (
	EnvIssuer        = "PORTAL_ISSUER"
	EnvIssuerAllow   = "PORTAL_ISSUER_ALLOWLIST"
	EnvFrameAllow    = "PORTAL_FRAME_ANCESTORS"
	EnvWebFrameAllow = "WEB_PORTAL_FRAME_ANCESTORS"
)

// Boundary is the non-negotiable integration split.
type Boundary struct {
	SharesDatabase             bool `json:"sharesDatabase"`
	SharesExecutor             bool `json:"sharesExecutor"`
	PortalEntryIsAuthorization bool `json:"portalEntryIsAuthorization"`
	HostTenantIsAuthorization  bool `json:"hostTenantIsAuthorization"`
	AssertionAcceptedFromURL   bool `json:"assertionAcceptedFromURL"`
	CredentialsOrRawLogsToHost bool `json:"credentialsOrRawLogsExposedToHost"`
	UsesEmbedMint              bool `json:"usesEmbedMint"`
	UsesEmbedExchange          bool `json:"usesEmbedExchange"`
	ParallelAuthPath           bool `json:"parallelAuthPath"`
}

// DefaultBoundary is fail-closed and documents the split for Chloe.
func DefaultBoundary() Boundary {
	return Boundary{
		SharesDatabase:             false,
		SharesExecutor:             false,
		PortalEntryIsAuthorization: false,
		HostTenantIsAuthorization:  false,
		AssertionAcceptedFromURL:   false,
		CredentialsOrRawLogsToHost: false,
		UsesEmbedMint:              true,
		UsesEmbedExchange:          true,
		ParallelAuthPath:           false,
	}
}

// HostStep is one documented hop in the Portal → FlowForge wiring.
type HostStep struct {
	ID    string `json:"id"`
	Actor string `json:"actor"`
	Do    string `json:"do"`
	Path  string `json:"path,omitempty"`
	Note  string `json:"note"`
}

// HostWiring is the Chloe / Portal-backend map. Entry is Portal-owned;
// mint and exchange are FlowForge E11.1/E11.2.
func HostWiring() []HostStep {
	return []HostStep{
		{
			ID:    "entry",
			Actor: "portal",
			Do:    "Portal navigation + Portal RBAC decide whether the user may enter the add-in.",
			Path:  EntryPath,
			Note:  "Portal entry is not FlowForge authorization. Do not share FlowForge cookies, DB, or the executor.",
		},
		{
			ID:    "map-roles",
			Actor: "portal-backend",
			Do:    "Map Portal roles to FlowForge capabilities via GET /api/v1/portal/adapter capabilityMap. Unknown roles fail closed.",
			Path:  "/api/v1/portal/adapter",
			Note:  "Mapped capabilities are a request, not a grant. FlowForge mint still requires a subset of the minting caller.",
		},
		{
			ID:    "mint",
			Actor: "portal-backend",
			Do:    "After Portal RBAC, mint an embed.v1 assertion with portal issuer, aud=flowforge, tenant_id, workbench_key, and mapped capabilities.",
			Path:  "/api/v1/portal/adapter/assertions",
			Note:  "Thin adapter over POST /api/v1/embed/assertions (E11.1). Same Ed25519 key, same claims. Compact JWS once. Never put it in a URL, log, or localStorage.",
		},
		{
			ID:    "mount",
			Actor: "portal-frontend",
			Do:    "Load the canonical UI at /embed/v1 (same standalone hrefs). Frame only if the Portal origin is in WEB_PORTAL_FRAME_ANCESTORS / WEB_EMBED_FRAME_ANCESTORS.",
			Path:  MountPrefix,
			Note:  "Chloe owns the embed shell. Do not rewrite the product tree. Host query tenant/workbench is display-only.",
		},
		{
			ID:    "exchange",
			Actor: "embed-shell",
			Do:    "POST {assertion,sdk:embed.v1} to the E11.1 exchange. Issues ff_session bound to (tenant_id, workbench_key).",
			Path:  "/api/v1/embed/exchange",
			Note:  "Not a Portal-specific exchange. Replay is 409. Body only.",
		},
		{
			ID:    "authorize",
			Actor: "flowforge",
			Do:    "Later API calls use the cookie session + CSRF + exchanged tenant/workbench headers. FlowForge membership ∩ minted capabilities is the grant.",
			Note:  "A Portal admin who is not a FlowForge member cannot administer or bootstrap tenants/sibling workbenches. platform.administer is never minted. Host-supplied tenant is never authorization.",
		},
	}
}

// MintTTL documents the same clamp as embed.v1.
func MintTTL() (min, def, max time.Duration) {
	return embed.MinTTL, embed.DefaultTTL, embed.MaxTTL
}
