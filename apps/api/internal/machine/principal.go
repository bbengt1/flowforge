// Package machine is the non-human principal for scrapers, the
// scheduler consumer, and other automation.
//
// A principal authenticates with client_id + secret or a short-lived
// signed assertion, then the HTTP layer mints the same standalone
// ff_session the human doors use. This package is not local login,
// not trusted-dev header identity, and not embed exchange.
//
// Secrets and assertion private keys are never returned on View.
// Grants are deny-by-default: an empty list authorizes nothing.
package machine

import (
	"slices"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

const (
	// Issuer is the users.issuer for machine principals. It is not an
	// IdP, not PLATFORM_ADMINS, and not an embed issuer.
	Issuer = "flowforge:machine"
	// Audience is the aud claim on machine assertions. Embed tokens
	// use aud=flowforge and are rejected here.
	Audience = "flowforge:machine"

	StatusActive  = "active"
	StatusRevoked = "revoked"
)

// Principal is a stored machine credential. Secret material is
// unexported so JSON encoding cannot echo it.
type Principal struct {
	ID           string
	UserID       string
	ClientID     string
	DisplayName  string
	Status       string
	Grants       []string
	TenantID     string
	WorkspaceID  string
	WorkbenchKey string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	RotatedAt    *time.Time
	RevokedAt    *time.Time
	secretHash   string
	publicKey    []byte
}

// View is the operator payload: display name, ids, and grants.
// No secret, hash, assertion, or private key.
type View struct {
	ID           string     `json:"id"`
	ClientID     string     `json:"client_id"`
	DisplayName  string     `json:"display_name"`
	Status       string     `json:"status"`
	Grants       []string   `json:"grants"`
	TenantID     string     `json:"tenant_id,omitempty"`
	WorkspaceID  string     `json:"workspace_id,omitempty"`
	WorkbenchKey string     `json:"workbench_key,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	RotatedAt    *time.Time `json:"rotated_at,omitempty"`
	RevokedAt    *time.Time `json:"revoked_at,omitempty"`
}

// View copies public fields only.
func (p Principal) View() View {
	grants := append([]string(nil), p.Grants...)
	if grants == nil {
		grants = []string{}
	}
	return View{
		ID:           p.ID,
		ClientID:     p.ClientID,
		DisplayName:  p.DisplayName,
		Status:       p.Status,
		Grants:       grants,
		TenantID:     p.TenantID,
		WorkspaceID:  p.WorkspaceID,
		WorkbenchKey: p.WorkbenchKey,
		CreatedAt:    p.CreatedAt,
		RotatedAt:    p.RotatedAt,
		RevokedAt:    p.RevokedAt,
	}
}

func (p Principal) clone() Principal {
	out := p
	out.Grants = append([]string(nil), p.Grants...)
	if len(p.publicKey) > 0 {
		out.publicKey = append([]byte(nil), p.publicKey...)
	}
	return out
}

func (p Principal) hasFactor() bool {
	return p.secretHash != "" || len(p.publicKey) == 32
}

// Grantable reports whether key may be stored on a machine principal.
// embed.impersonate stays on PLATFORM_ADMINS. Unknown keys are denied.
// platform.administer and ops.metrics.read are allowed only when an
// operator lists them; they are not a default.
func Grantable(key string) bool {
	key = strings.TrimSpace(key)
	if !authz.Known(key) || key == authz.PermEmbedImpersonate {
		return false
	}
	return true
}

// NormalizeGrants dedupes an explicit grant list. Empty is valid and
// authorizes nothing. Workspace-scoped keys require a workspace binding.
func NormalizeGrants(in []string, workspaceBound bool) ([]string, error) {
	seen := map[string]struct{}{}
	var out []string
	for _, raw := range in {
		key := strings.TrimSpace(raw)
		if !Grantable(key) {
			return nil, ErrInvalid
		}
		if _, ok := seen[key]; ok {
			continue
		}
		if !authz.PlatformScopedPermission(key) && !workspaceBound {
			return nil, ErrBinding
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	slices.Sort(out)
	return out, nil
}

// UnionWorkspace adds workspace-scoped machine grants to a membership
// permission set. Platform-scoped keys stay out of workspace authz.
func UnionWorkspace(existing, grants []string) []string {
	seen := map[string]struct{}{}
	out := append([]string(nil), existing...)
	for _, p := range out {
		seen[p] = struct{}{}
	}
	for _, g := range grants {
		if !authz.Known(g) || authz.PlatformScopedPermission(g) {
			continue
		}
		if _, ok := seen[g]; ok {
			continue
		}
		seen[g] = struct{}{}
		out = append(out, g)
	}
	return out
}
