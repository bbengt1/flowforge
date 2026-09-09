// Package ssh is the SSH engine: E8.1 target/profile management plus the
// isolated ssh.run worker (ephemeral handles, known-host verification,
// DNS/address allowlists, key-only auth).
package ssh

import (
	"errors"
	"fmt"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Vault credential type that may be bound to an SSH target.
const CredentialType = "ssh_private_key"

// Secret field names stored in the vault (never returned on ops-config APIs).
const (
	CredentialSecretFieldPrivateKey = "privateKey"
	CredentialSecretFieldPassphrase = "passphrase"
)

// Engine verb used by ssh.run.
const VerbRun = "run"

// Node type for the approved remote command profile.
const NodeSSHRun = "ssh.run"

// DefaultUsername is the non-root remote account when a target omits username.
const DefaultUsername = "flowforge"

// DefaultTimeoutSeconds is used when the node omits timeoutSeconds.
const DefaultTimeoutSeconds = 60

// MaxTimeoutSeconds is the bounded connect+command wait.
const MaxTimeoutSeconds = 3600

// DefaultConnectTimeout is the upper bound for TCP+SSH handshake.
const DefaultConnectTimeout = 15 * time.Second

// MaxStdoutBytes caps persisted stdout/stderr after redaction.
const MaxStdoutBytes = 16 << 10

// DefaultMaxAttempts is the E8.2/E8.3 retry default: never blindly re-run.
const DefaultMaxAttempts = 0

// MaxRetryAttempts is the catalog cap for retryPolicy.maxAttempts.
const MaxRetryAttempts = 5

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
	CodeAuthDenied          = "auth-denied"
	CodeForwardingDenied    = "forwarding-denied"
	CodeRootDenied          = "root-denied"
	CodeHandleForbidden     = "handle-forbidden"
	CodeRetryDenied         = "retry-denied"
	CodePolicyDenied        = "policy-denied"
	CodeConnectFailed       = "connect-failed"
	CodeCommandFailed       = "command-failed"
	CodeCanceled            = "canceled"
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
