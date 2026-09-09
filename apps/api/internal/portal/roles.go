package portal

import (
	"slices"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Portal role keys. Short aliases (viewer, operator, …) match FlowForge
// role vocabulary so a Portal host can send either form.
const (
	RoleViewer    = "portal.viewer"
	RoleEditor    = "portal.editor"
	RolePublisher = "portal.publisher"
	RoleOperator  = "portal.operator"
	RoleApprover  = "portal.approver"
	RoleAdmin     = "portal.admin"
)

// RoleBinding is one Portal role → FlowForge capability grant.
type RoleBinding struct {
	PortalRole   string   `json:"portalRole"`
	Aliases      []string `json:"aliases"`
	Capabilities []string `json:"capabilities"`
	Note         string   `json:"note"`
}

// CapabilityMap is the documented Portal → FlowForge mapping.
func CapabilityMap() []RoleBinding {
	out := make([]RoleBinding, 0, 6)
	for _, role := range []struct {
		key, alias, note string
	}{
		{RoleViewer, authz.RoleViewer, "Read-only catalog/run/health. Cannot edit, run, or manage credentials."},
		{RoleEditor, authz.RoleEditor, "Draft authoring. Cannot publish, execute, or administer."},
		{RolePublisher, authz.RolePublisher, "Edit and publish. Cannot execute or administer."},
		{RoleOperator, authz.RoleOperator, "Run published workflows and use credentials. Cannot edit definitions or administer."},
		{RoleApprover, authz.RoleApprover, "Decide approvals. Cannot edit, execute, or administer."},
		{RoleAdmin, authz.RoleAdmin, "Full FlowForge workspace administration. Still requires FlowForge membership after exchange."},
	} {
		ff := authz.ExpandRoles([]string{role.alias})
		out = append(out, RoleBinding{
			PortalRole:   role.key,
			Aliases:      []string{role.alias},
			Capabilities: append([]string(nil), ff...),
			Note:         role.note,
		})
	}
	return out
}

// NormalizeRole maps a Portal role or FlowForge role alias to the
// canonical portal.* key. Empty / unknown returns "".
func NormalizeRole(raw string) string {
	role := strings.ToLower(strings.TrimSpace(raw))
	if role == "" {
		return ""
	}
	switch role {
	case RoleViewer, authz.RoleViewer:
		return RoleViewer
	case RoleEditor, authz.RoleEditor:
		return RoleEditor
	case RolePublisher, authz.RolePublisher:
		return RolePublisher
	case RoleOperator, authz.RoleOperator:
		return RoleOperator
	case RoleApprover, authz.RoleApprover:
		return RoleApprover
	case RoleAdmin, authz.RoleAdmin:
		return RoleAdmin
	default:
		return ""
	}
}

// KnownRole reports whether raw is a Portal role or documented alias.
func KnownRole(raw string) bool {
	return NormalizeRole(raw) != ""
}

// MapRoles expands Portal roles to FlowForge permission keys.
// Unknown roles fail closed. Duplicates are collapsed in catalog order.
func MapRoles(roles []string) ([]string, error) {
	if len(roles) == 0 {
		return nil, ErrRoleRequired
	}
	ff := make([]string, 0, len(roles))
	for _, raw := range roles {
		canon := NormalizeRole(raw)
		if canon == "" {
			return nil, ErrUnknownRole
		}
		alias := strings.TrimPrefix(canon, "portal.")
		ff = append(ff, alias)
	}
	caps := authz.ExpandRoles(ff)
	if len(caps) == 0 {
		return nil, ErrUnknownRole
	}
	return caps, nil
}

// UnionCapabilities merges mapped roles with explicit FlowForge keys.
// Explicit keys must be known catalog permissions. Result is sorted-stable
// in catalog order.
func UnionCapabilities(roles, extra []string) ([]string, error) {
	var caps []string
	if len(roles) > 0 {
		mapped, err := MapRoles(roles)
		if err != nil {
			return nil, err
		}
		caps = append(caps, mapped...)
	}
	for _, raw := range extra {
		key := strings.TrimSpace(raw)
		if key == "" {
			continue
		}
		if !authz.Known(key) {
			return nil, ErrUnknownCapability
		}
		caps = append(caps, key)
	}
	if len(caps) == 0 {
		return nil, ErrRoleRequired
	}
	return uniqueCatalogOrder(caps), nil
}

func uniqueCatalogOrder(keys []string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, p := range authz.PermissionKeys() {
		if !slices.Contains(keys, p) {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}
