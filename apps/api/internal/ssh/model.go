// Package ssh is the control-plane model for SSH targets and immutable
// command profiles. E8.1 hardens management, typed parameters, and the
// reviewed renderer. Isolated ssh.run workers are E8.2.
package ssh

import (
	"errors"
	"fmt"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Vault credential type that may be bound to an SSH target.
const CredentialType = "ssh_private_key"

// Secret field names stored in the vault (never returned on ops-config APIs).
const (
	CredentialSecretFieldPrivateKey = "privateKey"
	CredentialSecretFieldPassphrase = "passphrase"
)

// Engine verb used by ssh.run. Isolated execution is E8.2.
const VerbRun = "run"

// Node type for the approved remote command profile.
const NodeSSHRun = "ssh.run"

// Template placeholder syntax owned by the reviewed renderer.
const PlaceholderSyntax = "{name}"

// QuotingPOSIXSingle is the only quoting algorithm the renderer applies.
const QuotingPOSIXSingle = "posix-single-quotes"

// Control-plane and future engine error codes (RFC 9457-aligned).
const (
	CodeInvalidTarget       = "invalid-target"
	CodeInvalidFingerprint  = "invalid-fingerprint"
	CodeInvalidAddress      = "invalid-address"
	CodeEmptyAllowlist      = "empty-allowlist"
	CodeInvalidSchema       = "invalid-schema"
	CodeInvalidTemplate     = "invalid-template"
	CodeInterpolationDenied = "interpolation-denied"
	CodeParameterRejected   = "parameter-rejected"
	CodeCredentialDenied    = "credential-denied"
	CodePermissionDenied    = "forbidden"
	CodeHostKeyMismatch     = "host-key-mismatch"
	CodeAddressDenied       = "address-denied"
	CodeTimeout             = "timeout"
	CodeIndeterminate       = "indeterminate"
)

// Shared validation errors. Wrapped with opsconfig.ErrInvalid at the store.
var (
	ErrInvalid = errors.New("invalid")
)

func wrapInvalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// RequiredPermissions is the FlowForge RBAC set for ssh.run execute paths.
func RequiredPermissions() []string {
	return []string{
		authz.PermWorkflowExecute,
		authz.PermSSHRun,
		authz.PermSSHTargetUse,
		authz.PermCommandProfileUse,
	}
}
