package runner

import (
	"errors"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// ErrProductionIdentityRequired is returned when a production-locked
// runner would claim as the first PLATFORM_ADMINS principal.
// Platform admin is not a workspace membership.
var ErrProductionIdentityRequired = errors.New("production runner requires RUNNER_USER_ID or RUNNER_ISSUER and RUNNER_SUBJECT")

// IdentityConfig is the runner principal. UserID wins. Otherwise both
// Issuer and Subject are required. When neither form is set, a
// non-production process may use the first PLATFORM_ADMINS pair.
// A production-locked process refuses that fallback.
type IdentityConfig struct {
	ProductionLocked bool
	UserID           string
	Issuer           string
	Subject          string
	PlatformAdmins   string
	PlatformAdmin    string
}

// ResolveIdentity returns the principal the runner looks up. It does
// not upsert. An empty result with a nil error means no identity was
// configured and no non-production fallback was available.
func ResolveIdentity(cfg IdentityConfig) (userID, issuer, subject string, err error) {
	userID = strings.TrimSpace(cfg.UserID)
	issuer = strings.TrimSpace(cfg.Issuer)
	subject = strings.TrimSpace(cfg.Subject)
	if userID != "" || (issuer != "" && subject != "") {
		return userID, issuer, subject, nil
	}
	if cfg.ProductionLocked {
		return "", "", "", ErrProductionIdentityRequired
	}
	admins := authz.ParsePlatformAdmins(cfg.PlatformAdmins, cfg.PlatformAdmin)
	if len(admins) == 0 {
		return "", "", "", nil
	}
	return "", admins[0].Issuer, admins[0].Subject, nil
}
