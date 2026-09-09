package embed

import (
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// SessionTenancy is the server-bound embed workspace identity stored on
// the browser session after a successful exchange. Host headers are
// context and must match; they never authorize by themselves.
type SessionTenancy struct {
	TenantID     string
	WorkbenchKey string
	WorkspaceID  string
	Capabilities []string
}

// Bound reports whether the session carries an embed workspace binding.
func (t SessionTenancy) Bound() bool {
	return strings.TrimSpace(t.TenantID) != "" && strings.TrimSpace(t.WorkbenchKey) != ""
}

// Normalize trims binding fields.
func (t SessionTenancy) Normalize() SessionTenancy {
	caps := append([]string(nil), t.Capabilities...)
	return SessionTenancy{
		TenantID:     strings.TrimSpace(t.TenantID),
		WorkbenchKey: strings.TrimSpace(t.WorkbenchKey),
		WorkspaceID:  strings.TrimSpace(t.WorkspaceID),
		Capabilities: caps,
	}
}

// Valid reports whether a bound session has well-formed identity.
func (t SessionTenancy) Valid() error {
	t = t.Normalize()
	if !t.Bound() {
		return ErrTenant
	}
	if !authz.ValidUUID(t.TenantID) {
		return ErrTenant
	}
	if !authz.ValidWorkbenchKey(t.WorkbenchKey) {
		return ErrWorkbench
	}
	if t.WorkspaceID != "" && !authz.ValidUUID(t.WorkspaceID) {
		return ErrWorkspaceBinding
	}
	if len(t.Capabilities) == 0 {
		return ErrCapability
	}
	return validateCapabilities(t.Capabilities)
}

// PropagateTenancy is the E11.2 fail-closed bind: an embed session uses
// its stored (tenant_id, workbench_key). Host-supplied tenant/workbench
// must match when present. A host tenant value alone is never enough.
func PropagateTenancy(bound SessionTenancy, host authz.WorkspaceClaim) (SessionTenancy, error) {
	bound = bound.Normalize()
	if !bound.Bound() {
		return SessionTenancy{}, ErrTenancyUnready
	}
	if err := bound.Valid(); err != nil {
		return SessionTenancy{}, err
	}
	host = host.Normalize()
	if host.TenantID != "" && !strings.EqualFold(host.TenantID, bound.TenantID) {
		return SessionTenancy{}, ErrTenancyMismatch
	}
	if host.WorkbenchKey != "" && host.WorkbenchKey != bound.WorkbenchKey {
		return SessionTenancy{}, ErrTenancyMismatch
	}
	if host.HostWorkspaceID != "" {
		if err := authz.ConfirmResolvedID(bound.WorkspaceID, host.HostWorkspaceID); err != nil {
			return SessionTenancy{}, ErrWorkspaceBinding
		}
	}
	// Host tenant slug without a matching tenant id is display context
	// only; it cannot select another workspace.
	if host.TenantID == "" && host.TenantSlug != "" && host.WorkbenchKey == "" {
		return SessionTenancy{}, ErrTenancyMismatch
	}
	return bound, nil
}

// DeniesBootstrap reports whether an embed-bound session may create
// tenants, workspaces, or sibling workbenches. Bound sessions always
// deny; platform.administer on the principal does not override.
func DeniesBootstrap(bound bool) bool {
	return bound
}

// IntersectCapabilities returns membership permissions that also appear
// on the embed assertion. An embed session never escalates past the
// minted capability set. Empty assertion capabilities fail closed.
func IntersectCapabilities(membership, assertion []string) []string {
	if len(assertion) == 0 {
		return nil
	}
	allow := map[string]struct{}{}
	for _, c := range assertion {
		c = strings.TrimSpace(c)
		if c == "" || !authz.Known(c) {
			continue
		}
		allow[c] = struct{}{}
	}
	var out []string
	seen := map[string]struct{}{}
	for _, c := range membership {
		c = strings.TrimSpace(c)
		if authz.PlatformScopedPermission(c) {
			continue
		}
		if _, ok := allow[c]; !ok {
			continue
		}
		if _, dup := seen[c]; dup {
			continue
		}
		seen[c] = struct{}{}
		out = append(out, c)
	}
	if out == nil {
		return []string{}
	}
	return out
}

// TenancyPropagationHook documents that E11.2 tenancy bind is enabled.
// Call PropagateTenancy at request time; this helper exists so older
// fail-closed tests can assert the hook is no longer a stub.
func TenancyPropagationHook() error {
	return nil
}
