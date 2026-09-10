package portal

import (
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
)

// MintRequest is the Portal-facing mint body. PortalRoles are mapped to
// FlowForge capabilities; Capabilities may add extra known keys.
type MintRequest struct {
	Subject      string   `json:"subject"`
	DisplayName  string   `json:"displayName"`
	Issuer       string   `json:"issuer"`
	TenantID     string   `json:"tenantId"`
	WorkbenchKey string   `json:"workbenchKey"`
	WorkspaceID  string   `json:"workspaceId"`
	PortalRoles  []string `json:"portalRoles"`
	Capabilities []string `json:"capabilities"`
	TTLSeconds   int      `json:"ttlSeconds"`
}

// PrepareMint maps Portal roles and builds an E11.1 MintInput.
// It does not sign. Signing stays in embed.Mint. Subject is bound to
// the caller unless canImpersonate (embed.impersonate / PLATFORM_ADMINS).
// Issuer is always the caller; a mismatched client issuer is rejected.
func PrepareMint(req MintRequest, callerIssuer, callerSubject, display, tenantID, workbench, workspaceID string, allow []string, now time.Time, canImpersonate bool) (embed.MintInput, []string, bool, error) {
	caps, err := UnionCapabilities(req.PortalRoles, req.Capabilities)
	if err != nil {
		return embed.MintInput{}, nil, false, err
	}
	issuer, subject, impersonating, err := authz.BindMintIdentity(callerIssuer, callerSubject, req.Issuer, req.Subject, canImpersonate)
	if err != nil {
		return embed.MintInput{}, nil, false, err
	}
	if !IssuerAllowed(issuer, allow) {
		return embed.MintInput{}, nil, false, ErrIssuer
	}
	name := strings.TrimSpace(req.DisplayName)
	if name == "" && subject == strings.TrimSpace(callerSubject) {
		name = strings.TrimSpace(display)
	}
	ttl := time.Duration(req.TTLSeconds) * time.Second
	return embed.MintInput{
		Issuer:       issuer,
		Subject:      subject,
		DisplayName:  name,
		Host:         strings.TrimSpace(callerIssuer),
		Context:      embed.HostContextPortal,
		TenantID:     tenantID,
		WorkbenchKey: workbench,
		WorkspaceID:  workspaceID,
		Capabilities: caps,
		TTL:          ttl,
		Audience:     Audience,
		Now:          now,
	}, caps, impersonating, nil
}
