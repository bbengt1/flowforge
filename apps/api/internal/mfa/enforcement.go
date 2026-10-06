package mfa

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// EnvEnforcement is the opt-in step-up bypass. Unset and "on" keep
// today's enforcement. "off" is honored only when the process is not
// production-locked.
const EnvEnforcement = "MFA_ENFORCEMENT"

// EnforcementOn and EnforcementOff are the only values GET /session/mfa
// reports, and the only values ResolveEnforcement accepts besides empty.
const (
	EnforcementOn  = "on"
	EnforcementOff = "off"
)

// ResolveEnforcement decides whether privileged MFA step-up is skipped.
//
// Empty and "on" keep enforcement (off == false). "off" is honored only
// when ProductionLocked is false — the same gate localseed.Resolve and
// trusted-dev use, so an empty APP_ENV, REQUIRE_TLS=true, and unknown
// values all count as production. "off" in that state is a boot error.
// Any other value is a boot error. Errors name the variable and never
// include the raw value.
func ResolveEnforcement(raw, appEnv string, requireTLS bool) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", EnforcementOn:
		return false, nil
	case EnforcementOff:
		if authz.ProductionLocked(appEnv, requireTLS) {
			return false, fmt.Errorf("%s=%s is refused for a production-locked process (empty, production, or unknown %s, or %s=true)", EnvEnforcement, EnforcementOff, authz.EnvAppEnv, authz.EnvRequireTLS)
		}
		return true, nil
	default:
		return false, fmt.Errorf("%s must be unset, %s, or %s", EnvEnforcement, EnforcementOn, EnforcementOff)
	}
}

// WarnBypass logs that privileged step-up is skipped. Call it on every
// API boot while the bypass is active. The text names the setting and
// carries no secret material.
func WarnBypass(log *slog.Logger) {
	if log == nil {
		return
	}
	log.Warn("MFA_ENFORCEMENT=off; privileged MFA step-up is skipped (dev/QA only)")
}
