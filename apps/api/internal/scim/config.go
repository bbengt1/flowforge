package scim

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

const (
	EnvBearerToken = "SCIM_BEARER_TOKEN"
	EnvIssuer      = "SCIM_ISSUER"
	EnvDefaultRole = "SCIM_DEFAULT_ROLE"
	EnvGroupsMode  = "SCIM_GROUPS_MODE"

	// GroupsModeWorkspaces is the default: a SCIM Group is a workspace,
	// and a Group member change adds or removes workspace membership.
	GroupsModeWorkspaces = "workspaces"
	// GroupsModeGroups maps SCIM Groups to Flowforge groups inside one
	// workspace, managed only by that workspace's SCIM tokens. The
	// instance token is refused on /Groups in this mode.
	GroupsModeGroups = "groups"

	// DefaultRole is the workspace role added when a Group member is new.
	// It is not platform-admin and not a second authorization system.
	DefaultRole = authz.RoleViewer

	minTokenLen = 32
	maxTokenLen = 256
)

// Settings is the dedicated SCIM bearer. The token is compared in
// constant time and is never stored, logged, or returned.
type Settings struct {
	BearerToken string
	Issuer      string
	DefaultRole string
	// GroupsMode is GroupsModeWorkspaces or GroupsModeGroups. The zero
	// value means GroupsModeWorkspaces.
	GroupsMode string
}

// Groups reports whether the instance runs SCIM_GROUPS_MODE=groups.
// Anything else, including the zero value, is workspaces mode.
func (s Settings) Groups() bool {
	return s.GroupsMode == GroupsModeGroups
}

// Mode is the effective SCIM_GROUPS_MODE value.
func (s Settings) Mode() string {
	if s.Groups() {
		return GroupsModeGroups
	}
	return GroupsModeWorkspaces
}

// LoadGroupsMode reads SCIM_GROUPS_MODE. Empty is workspaces. Any value
// other than workspaces or groups is an error, so the server refuses to
// boot rather than guess. The value is checked even when SCIM is off.
func LoadGroupsMode() (string, error) {
	raw := strings.TrimSpace(os.Getenv(EnvGroupsMode))
	switch raw {
	case "", GroupsModeWorkspaces:
		return GroupsModeWorkspaces, nil
	case GroupsModeGroups:
		return GroupsModeGroups, nil
	}
	return "", fmt.Errorf("%s must be %q or %q", EnvGroupsMode, GroupsModeWorkspaces, GroupsModeGroups)
}

// Ready reports whether the instance-wide bearer (SCIM_BEARER_TOKEN)
// can provision and deprovision.
func (s Settings) Ready() bool {
	return s.BearerToken != "" && s.Issuer != "" && s.DefaultRole != ""
}

// WorkspaceReady reports whether per-workspace tokens can be minted and
// used. It needs an issuer and a default role, not the instance bearer.
func (s Settings) WorkspaceReady() bool {
	return s.Issuer != "" && s.DefaultRole != ""
}

// Match reports whether presented equals the configured bearer.
// Unequal lengths do not short-circuit the compare.
func (s Settings) Match(presented string) bool {
	if !s.Ready() || presented == "" {
		return false
	}
	sumA := sha256.Sum256([]byte(s.BearerToken))
	sumB := sha256.Sum256([]byte(presented))
	return subtle.ConstantTimeCompare(sumA[:], sumB[:]) == 1
}

// Load reads SCIM_* from the environment. All empty leaves SCIM off:
// the /scim/v2 routes fail closed and workspace tokens cannot be
// created. Setting any SCIM_* variable turns SCIM on and needs an
// issuer: SCIM_ISSUER, or OIDC_ISSUER when SCIM_ISSUER is omitted. The
// instance bearer is optional; without it only workspace tokens work.
// When oidcIssuer is set, SCIM_ISSUER must match it so provisioned
// users are the same principal OIDC sign-in resolves. SCIM_GROUPS_MODE
// is validated first (see LoadGroupsMode). Errors never include the
// bearer token.
func Load(production bool, oidcIssuer string) (Settings, error) {
	mode, err := LoadGroupsMode()
	if err != nil {
		return Settings{}, err
	}
	token := strings.TrimSpace(os.Getenv(EnvBearerToken))
	issuer := strings.TrimSpace(os.Getenv(EnvIssuer))
	role := strings.TrimSpace(os.Getenv(EnvDefaultRole))
	if token == "" && issuer == "" && role == "" {
		return Settings{GroupsMode: mode}, nil
	}
	if issuer == "" && strings.TrimSpace(oidcIssuer) == "" {
		return Settings{}, fmt.Errorf("%s (or OIDC_ISSUER) must be set when SCIM is configured", EnvIssuer)
	}
	if token != "" && (len(token) < minTokenLen || len(token) > maxTokenLen || hasControl(token) || strings.Contains(token, " ")) {
		return Settings{}, fmt.Errorf("%s is malformed", EnvBearerToken)
	}
	if IsWorkspaceToken(token) {
		return Settings{}, fmt.Errorf("%s must not use the workspace token prefix", EnvBearerToken)
	}
	if issuer == "" {
		issuer = oidcIssuer
	}
	norm, err := normalizeIssuer(issuer, production)
	if err != nil {
		return Settings{}, fmt.Errorf("%s: %w", EnvIssuer, err)
	}
	oidcIssuer = strings.TrimRight(strings.TrimSpace(oidcIssuer), "/")
	if oidcIssuer != "" && norm != oidcIssuer {
		return Settings{}, fmt.Errorf("%s must match OIDC_ISSUER", EnvIssuer)
	}
	if role == "" {
		role = DefaultRole
	}
	if !authz.WorkspaceAssignableRole(role) {
		return Settings{}, fmt.Errorf("%s must be a workspace role", EnvDefaultRole)
	}
	return Settings{BearerToken: token, Issuer: norm, DefaultRole: role, GroupsMode: mode}, nil
}

func normalizeIssuer(raw string, production bool) (string, error) {
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", ErrInvalid
	}
	if production {
		if u.Scheme != "https" {
			return "", ErrInvalid
		}
	} else if u.Scheme != "https" && u.Scheme != "http" {
		return "", ErrInvalid
	}
	if hasControl(raw) || len(raw) > 512 {
		return "", ErrInvalid
	}
	return raw, nil
}

func hasControl(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
