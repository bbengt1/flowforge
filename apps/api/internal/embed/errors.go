package embed

import "errors"

// Validation and store errors. Callers must fail closed.
var (
	ErrMissingClaim     = errors.New("embed assertion is missing a required claim")
	ErrAudience         = errors.New("embed assertion audience is not bound to FlowForge")
	ErrExpired          = errors.New("embed assertion has expired")
	ErrNotYetValid      = errors.New("embed assertion is not yet valid")
	ErrSignature        = errors.New("embed assertion signature is not valid")
	ErrReplay           = errors.New("embed assertion token id has already been used")
	ErrSDK              = errors.New("embed assertion sdk version is not supported")
	ErrCapability       = errors.New("embed assertion capabilities are not valid")
	ErrWorkspaceBinding = errors.New("embed assertion workspace binding does not match server resolution")
	ErrKeyUnavailable   = errors.New("embed signing key is not available")
	// ErrSigningKeyRequired is a boot-fail: production-locked processes
	// (empty/production APP_ENV or REQUIRE_TLS) must set a durable
	// EMBED_SIGNING_KEY. Local/dev/test may mint a crypto/rand ephemeral
	// key (no committed seed).
	ErrSigningKeyRequired = errors.New("EMBED_SIGNING_KEY is required in production")
	ErrIssuer             = errors.New("embed assertion issuer is not valid")
	ErrIssuerNotAllowed   = errors.New("embed assertion issuer is not on the allowlist")
	ErrSubject            = errors.New("embed assertion subject is not valid")
	ErrTokenID            = errors.New("embed assertion token id is not valid")
	ErrTenant             = errors.New("embed assertion tenant_id is not valid")
	ErrWorkbench          = errors.New("embed assertion workbench_key is not valid")
	ErrTTL                = errors.New("embed assertion ttl is not valid")
	ErrStoreUnavailable   = errors.New("embed assertion store is unavailable")
	ErrUnknownKey         = errors.New("embed assertion key id is not active or overlapping")
	ErrOverlapNotPrior    = errors.New("embed overlap key must be the previous active signing key")
	// ErrOverlapUntilRequired is missing, zero, or already-elapsed
	// overlapUntil on an overlap verify key (ADV-014). Zero is not forever.
	ErrOverlapUntilRequired = errors.New("embed overlap key requires a short overlapUntil")
	// ErrOverlapUntilTooLong is overlapUntil beyond MaxOverlapTTL.
	ErrOverlapUntilTooLong = errors.New("embed overlapUntil exceeds the maximum TTL")
	ErrRotationUnready     = errors.New("embed key rotation overlap is not enabled")
	ErrTenancyUnready      = errors.New("embed tenancy propagation is not enabled")
	ErrTenancyMismatch     = errors.New("embed session tenant/workbench does not match host context")
	ErrBootstrap           = errors.New("embed sessions cannot create tenants or workspaces")
)
