package authz

import (
	"errors"
	"strings"
	"unicode"
)

// Errors for workspace identity resolution. Host-supplied workspace IDs are
// never used as the lookup key.
var (
	ErrAmbiguousWorkspaceIdentity = errors.New("ambiguous workspace identity")
	ErrHostSuppliedWorkspaceID    = errors.New("host-supplied workspace identity is not accepted")
	ErrWorkspaceIdentityMismatch  = errors.New("host-supplied workspace identity does not match server resolution")
	ErrIncompleteWorkspaceClaim   = errors.New("tenant and workbench_key are required")
)

// WorkspaceClaim is untrusted host context. The server resolves the workspace
// from (tenant_id or tenant_slug, workbench_key) only.
type WorkspaceClaim struct {
	TenantID        string
	TenantSlug      string
	WorkbenchKey    string
	HostWorkspaceID string
}

// Normalize trims claim fields.
func (c WorkspaceClaim) Normalize() WorkspaceClaim {
	return WorkspaceClaim{
		TenantID:        strings.TrimSpace(c.TenantID),
		TenantSlug:      strings.TrimSpace(c.TenantSlug),
		WorkbenchKey:    strings.TrimSpace(c.WorkbenchKey),
		HostWorkspaceID: strings.TrimSpace(c.HostWorkspaceID),
	}
}

// ValidateClaim rejects host-supplied or incomplete workspace identity.
// A workspace UUID is never sufficient and is never used as the lookup key.
func ValidateClaim(c WorkspaceClaim) error {
	c = c.Normalize()

	hasTenant := c.TenantID != "" || c.TenantSlug != ""
	hasWorkbench := c.WorkbenchKey != ""
	hasHostID := c.HostWorkspaceID != ""

	if hasHostID && (!hasTenant || !hasWorkbench) {
		return ErrHostSuppliedWorkspaceID
	}
	if hasHostID && !ValidUUID(c.HostWorkspaceID) {
		return ErrHostSuppliedWorkspaceID
	}
	if !hasTenant || !hasWorkbench {
		return ErrIncompleteWorkspaceClaim
	}
	if c.TenantID != "" && !ValidUUID(c.TenantID) {
		return ErrAmbiguousWorkspaceIdentity
	}
	if c.TenantSlug != "" && !ValidTenantSlug(c.TenantSlug) {
		return ErrAmbiguousWorkspaceIdentity
	}
	if !ValidWorkbenchKey(c.WorkbenchKey) {
		return ErrAmbiguousWorkspaceIdentity
	}
	return nil
}

// ConfirmResolvedID rejects a host-supplied workspace UUID that does not
// equal the server-derived workspace. An empty host value is ignored.
func ConfirmResolvedID(resolvedWorkspaceID, hostWorkspaceID string) error {
	hostWorkspaceID = strings.TrimSpace(hostWorkspaceID)
	if hostWorkspaceID == "" {
		return nil
	}
	if !ValidUUID(hostWorkspaceID) || !ValidUUID(resolvedWorkspaceID) {
		return ErrHostSuppliedWorkspaceID
	}
	if !strings.EqualFold(resolvedWorkspaceID, hostWorkspaceID) {
		return ErrWorkspaceIdentityMismatch
	}
	return nil
}

// ForbiddenIdentityFields are JSON keys that attempt to set workspace identity.
var ForbiddenIdentityFields = []string{"id", "workspace_id", "workspaceId"}

// ValidUUID reports whether s is a 36-character hex UUID with hyphens.
func ValidUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		switch i {
		case 8, 13, 18, 23:
			if r != '-' {
				return false
			}
		default:
			if !isHex(r) {
				return false
			}
		}
	}
	return true
}

func isHex(r rune) bool {
	return (r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')
}

// ValidTenantSlug reports whether s matches the stored tenant slug format.
func ValidTenantSlug(s string) bool {
	if len(s) < 1 || len(s) > 63 {
		return false
	}
	if s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			continue
		}
		return false
	}
	return true
}

// ValidWorkbenchKey reports whether s matches the stored workbench key format.
func ValidWorkbenchKey(s string) bool {
	if len(s) < 1 || len(s) > 64 {
		return false
	}
	r0 := rune(s[0])
	if !((r0 >= 'a' && r0 <= 'z') || (r0 >= '0' && r0 <= '9')) {
		return false
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

// ValidIssuer is a non-empty issuer without control characters.
func ValidIssuer(s string) bool {
	s = strings.TrimSpace(s)
	return len(s) >= 1 && len(s) <= 512 && !hasControl(s)
}

// ValidSubject is a non-empty external subject without control characters.
func ValidSubject(s string) bool {
	s = strings.TrimSpace(s)
	return len(s) >= 1 && len(s) <= 256 && !hasControl(s)
}

func hasControl(s string) bool {
	for _, r := range s {
		if unicode.IsControl(r) {
			return true
		}
	}
	return false
}
