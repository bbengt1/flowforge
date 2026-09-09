package embed

import "time"

// Versioned embed SDK/contract (E11.1).
const (
	SDKVersion      = "embed.v1"
	DefaultAudience = "flowforge"
	Algorithm       = "EdDSA"
	KeyType         = "OKP"
	Curve           = "Ed25519"
	TokenType       = "JWT"

	DefaultTTL = 60 * time.Second
	MinTTL     = 15 * time.Second
	MaxTTL     = 5 * time.Minute

	// MountPrefix is the stable embed mount of the canonical UI.
	// Deep links under this prefix are the same routes as standalone.
	MountPrefix = "/embed/v1"
)

// Environment sources for the FlowForge signing key. The private key is
// never returned from an API. Production must set a stable key; an empty
// source yields an ephemeral process key (assertions die on restart).
const (
	EnvSigningKey     = "EMBED_SIGNING_KEY"
	EnvSigningKeyFile = "EMBED_SIGNING_KEY_FILE"
	EnvSigningKeyID   = "EMBED_SIGNING_KEY_ID"
	EnvAudience       = "EMBED_AUDIENCE"
	EnvAssertionTTL   = "EMBED_ASSERTION_TTL"
	EnvIssuer         = "EMBED_ISSUER"
	EnvIssuerAllow    = "EMBED_ISSUER_ALLOWLIST"
	EnvOverlapKeys    = "EMBED_OVERLAP_KEYS"
)

// Required JWT/assertion claims. workspace_id is an optional binding and
// is never authorization by itself.
var RequiredClaims = []string{
	"iss", "aud", "sub", "nbf", "exp", "jti",
	"tenant_id", "workbench_key", "capabilities", "sdk",
}

// Claims is the signed embed assertion payload.
type Claims struct {
	Issuer       string   `json:"iss"`
	Audience     string   `json:"aud"`
	Subject      string   `json:"sub"`
	NotBefore    int64    `json:"nbf"`
	ExpiresAt    int64    `json:"exp"`
	TokenID      string   `json:"jti"`
	TenantID     string   `json:"tenant_id"`
	WorkbenchKey string   `json:"workbench_key"`
	WorkspaceID  string   `json:"workspace_id,omitempty"`
	Capabilities []string `json:"capabilities"`
	SDK          string   `json:"sdk"`
	DisplayName  string   `json:"display_name,omitempty"`
	Host         string   `json:"host,omitempty"`
}

// PublicView is the secret-free assertion metadata returned to callers.
// It never includes the compact JWS except on mint (once).
type PublicView struct {
	SDK          string    `json:"sdk"`
	TokenID      string    `json:"tokenId"`
	Issuer       string    `json:"issuer"`
	Audience     string    `json:"audience"`
	Subject      string    `json:"subject"`
	TenantID     string    `json:"tenantId"`
	WorkbenchKey string    `json:"workbenchKey"`
	WorkspaceID  string    `json:"workspaceId,omitempty"`
	Capabilities []string  `json:"capabilities"`
	NotBefore    time.Time `json:"notBefore"`
	ExpiresAt    time.Time `json:"expiresAt"`
	KeyID        string    `json:"keyId"`
	Algorithm    string    `json:"algorithm"`
	DisplayName  string    `json:"displayName,omitempty"`
}

// Minted is returned once when FlowForge signs an assertion.
type Minted struct {
	PublicView
	Assertion string `json:"assertion"`
}

// PublicViewFromClaims projects secret-free metadata.
func PublicViewFromClaims(c Claims, kid string) PublicView {
	return PublicView{
		SDK:          c.SDK,
		TokenID:      c.TokenID,
		Issuer:       c.Issuer,
		Audience:     c.Audience,
		Subject:      c.Subject,
		TenantID:     c.TenantID,
		WorkbenchKey: c.WorkbenchKey,
		WorkspaceID:  c.WorkspaceID,
		Capabilities: append([]string(nil), c.Capabilities...),
		NotBefore:    time.Unix(c.NotBefore, 0).UTC(),
		ExpiresAt:    time.Unix(c.ExpiresAt, 0).UTC(),
		KeyID:        kid,
		Algorithm:    Algorithm,
		DisplayName:  c.DisplayName,
	}
}

// Route is a stable UI mount / deep link that works standalone and embed.
type Route struct {
	ID          string `json:"id"`
	Standalone  string `json:"standalone"`
	Embed       string `json:"embed"`
	Description string `json:"description"`
}

// CanonicalRoutes is the E11.1 mount map. Embed paths prefix the same
// standalone hrefs with /embed/v1. Query and hash fragments are unchanged.
func CanonicalRoutes() []Route {
	entries := []struct {
		id, path, help string
	}{
		{"home", "/", "Workspace home"},
		{"workflows", "/workflows", "Workflow list"},
		{"workflow", "/workflows/{id}", "Workflow editor"},
		{"actions", "/actions", "Action library"},
		{"templates", "/templates", "Templates"},
		{"credentials", "/credentials", "Credential vault"},
		{"credentialNew", "/credentials/new", "Create credential"},
		{"credential", "/credentials/{id}", "Credential detail"},
		{"executions", "/executions", "Execution history"},
		{"execution", "/executions/{id}", "Execution replay"},
		{"approvals", "/approvals", "Approval inbox"},
		{"approval", "/approvals/{id}", "Approval detail"},
		{"config", "/config", "Ops config"},
		{"configKind", "/config/{kind}", "Ops config collection"},
		{"configNew", "/config/{kind}/new", "Create ops-config resource"},
		{"configResource", "/config/{kind}/{id}", "Ops-config resource"},
		{"configVersion", "/config/{kind}/{id}/versions/{versionId}", "Ops-config version"},
		{"alerts", "/alerts", "Operational alerts"},
		{"alert", "/alerts/{id}", "Alert detail"},
		{"audit", "/audit", "Audit browse"},
		{"settings", "/settings", "Settings"},
		{"membership", "/membership", "Membership operator"},
		{"isolation", "/isolation", "Isolation exercise"},
	}
	out := make([]Route, 0, len(entries))
	for _, e := range entries {
		embedPath := MountPrefix
		if e.path != "/" {
			embedPath = MountPrefix + e.path
		}
		out = append(out, Route{
			ID:          e.id,
			Standalone:  e.path,
			Embed:       embedPath,
			Description: e.help,
		})
	}
	return out
}

// EmbedPath returns the embed mount of a standalone path.
func EmbedPath(standalone string) string {
	if standalone == "" || standalone == "/" {
		return MountPrefix
	}
	if standalone[0] != '/' {
		standalone = "/" + standalone
	}
	return MountPrefix + standalone
}
