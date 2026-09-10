package authz

import (
	"fmt"
	"os"
	"strings"
)

// Environment sources for the trusted-dev identity-header escape hatch.
// Production (empty/missing APP_ENV, production, or REQUIRE_TLS) is
// fail-closed: self-asserted Issuer/Subject headers are not authentication.
const (
	EnvTrustedDevIdentityHeaders = "TRUSTED_DEV_IDENTITY_HEADERS"
	EnvAppEnv                    = "APP_ENV"
	EnvFlowforgeEnv              = "FLOWFORGE_ENV"
	EnvRequireTLS                = "REQUIRE_TLS"
)

// NonProductionAppEnv reports whether appEnv is an explicit local/dev/test
// value. Empty, production, and unknown values are production-locked.
func NonProductionAppEnv(appEnv string) bool {
	switch strings.ToLower(strings.TrimSpace(appEnv)) {
	case "development", "dev", "local", "test":
		return true
	default:
		return false
	}
}

// ProductionLocked is the ADV-002/006 gate: empty/`production`/unknown
// APP_ENV, or REQUIRE_TLS. Used for durable signing keys, trusted-dev
// identity, and production-only https issuers (ADV-018).
func ProductionLocked(appEnv string, requireTLS bool) bool {
	return requireTLS || !NonProductionAppEnv(appEnv)
}

// ProductionLockedFromEnv reads APP_ENV / FLOWFORGE_ENV and REQUIRE_TLS.
func ProductionLockedFromEnv() bool {
	appEnv := strings.TrimSpace(os.Getenv(EnvAppEnv))
	if appEnv == "" {
		appEnv = strings.TrimSpace(os.Getenv(EnvFlowforgeEnv))
	}
	return ProductionLocked(appEnv, truthyEnv(os.Getenv(EnvRequireTLS)))
}

// ResolveTrustedDevIdentityHeaders enables self-asserted
// X-FlowForge-Issuer / X-FlowForge-Subject authentication and POST /session
// principal upsert only when the flag is explicit and the process is not
// production-locked. Empty or missing config is fail-closed (false, nil).
// A leftover flag combined with empty/production APP_ENV or REQUIRE_TLS
// returns an error so it cannot stay on accidentally.
func ResolveTrustedDevIdentityHeaders(flag, appEnv string, requireTLS bool) (bool, error) {
	if !truthyEnv(flag) {
		return false, nil
	}
	if requireTLS {
		return false, fmt.Errorf("%s cannot be enabled when REQUIRE_TLS=true", EnvTrustedDevIdentityHeaders)
	}
	if !NonProductionAppEnv(appEnv) {
		return false, fmt.Errorf("%s requires %s=development|dev|local|test (empty or production is fail-closed)", EnvTrustedDevIdentityHeaders, EnvAppEnv)
	}
	return true, nil
}

func truthyEnv(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
