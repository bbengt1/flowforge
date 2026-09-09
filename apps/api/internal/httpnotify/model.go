// Package httpnotify is the E10.4 HTTP and notification engine:
// http.request, notification.webhook, and notification.email using pinned
// connection / recipient-list / template / response-schema revisions.
package httpnotify

import (
	"errors"
	"fmt"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Connection types that may be bound to these nodes.
const (
	ConnectionHTTP    = "http"
	ConnectionWebhook = "webhook"
	ConnectionSMTP    = "smtp"
)

// Node types.
const (
	NodeHTTPRequest = "http.request"
	NodeWebhook     = "notification.webhook"
	NodeEmail       = "notification.email"
)

// Vault credential type that may authorize an HTTP/webhook connection.
const CredentialType = "token"

// Default and hard bounds.
const (
	DefaultTimeoutSeconds   = 15
	MaxTimeoutSeconds       = 60
	DefaultMaxRequestBytes  = 16 << 10
	DefaultMaxResponseBytes = 16 << 10
	HardMaxBodyBytes        = 1 << 20
	DefaultMaxRedirects     = 0
	MaxRedirects            = 5
	MaxAuditBodyBytes       = 2048
	IdempotencyHeader       = "Idempotency-Key"
	DefaultMaxAttempts      = 0
	MaxRetryAttempts        = 0
)

// Control-plane and engine error codes (RFC 9457-aligned).
const (
	CodeInvalidConnection   = "invalid-connection"
	CodeInvalidEndpoint     = "invalid-endpoint"
	CodeEmptyAllowlist      = "empty-allowlist"
	CodeAddressDenied       = "address-denied"
	CodeSSRFDenied          = "ssrf-denied"
	CodeRedirectDenied      = "redirect-denied"
	CodeMethodDenied        = "method-denied"
	CodePathDenied          = "path-denied"
	CodeTLSRequired         = "tls-required"
	CodeOversize            = "oversize"
	CodeSecretDenied        = "secret-denied"
	CodeWrongConnectionType = "wrong-connection-type"
	CodeUnpublishedPin      = "unpublished-pin"
	CodeTenancyDenied       = "tenancy-denied"
	CodeRecipientDenied     = "recipient-denied"
	CodeTemplateDenied      = "template-denied"
	CodePermissionDenied    = "forbidden"
	CodePolicyDenied        = "policy-denied"
	CodeTimeout             = "timeout"
	CodeCanceled            = "canceled"
	CodeDeliveryFailed      = "delivery-failed"
	CodeSchemaRejected      = "schema-rejected"
	CodeInterpolationDenied = "interpolation-denied"
	CodeIndeterminate       = "indeterminate"
)

// Shared validation error wrapped by opsconfig.
var ErrInvalid = errors.New("invalid")

func wrapInvalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// RequiredPermissions is the FlowForge RBAC set for a node.
func RequiredPermissions(op string) []string {
	switch op {
	case NodeHTTPRequest:
		return []string{authz.PermWorkflowExecute, authz.PermConnectionUse, authz.PermResponseSchemaUse}
	case NodeWebhook:
		return []string{authz.PermWorkflowExecute, authz.PermConnectionUse}
	case NodeEmail:
		return []string{
			authz.PermWorkflowExecute,
			authz.PermConnectionUse,
			authz.PermRecipientListUse,
			authz.PermMessageTemplateUse,
		}
	default:
		return []string{authz.PermWorkflowExecute}
	}
}

// ExpectedConnectionType is the connection.spec.type required by a node.
func ExpectedConnectionType(op string) string {
	switch op {
	case NodeHTTPRequest:
		return ConnectionHTTP
	case NodeWebhook:
		return ConnectionWebhook
	case NodeEmail:
		return ConnectionSMTP
	default:
		return ""
	}
}

// IntegrationNodes is the closed set gated by the integration suite.
func IntegrationNodes() []string {
	return []string{NodeHTTPRequest, NodeWebhook, NodeEmail}
}

// IntegrationSuites documents the negative suite that enables the catalog.
func IntegrationSuites() []string {
	return []string{
		"ssrf-denied",
		"redirect-denied",
		"dns-rebinding-denied",
		"oversize",
		"secret-redaction",
		"wrong-connection-type",
		"unpublished-pin",
		"tenancy",
		"email-recipient-deny",
	}
}
