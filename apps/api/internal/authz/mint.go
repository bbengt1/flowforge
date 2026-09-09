package authz

import (
	"errors"
	"strings"
)

// Mint identity bind errors. Callers must fail closed (403).
var (
	ErrMintImpersonation = errors.New("mint subject differs from caller without embed.impersonate")
	ErrMintIssuerSpoof   = errors.New("mint issuer differs from caller")
)

// CanEmbedImpersonate reports whether the caller may mint for another
// subject. Grant path is PLATFORM_ADMINS (same allowlist as
// platform.administer). Empty allowlist is fail-closed. The catalog
// key embed.impersonate is platform-scoped and is never granted by a
// workspace role.
func CanEmbedImpersonate(issuer, subject string, allow []PrincipalRef) bool {
	return IsPlatformAdmin(issuer, subject, allow)
}

// BindMintIdentity binds assertion iss/sub to the authenticated caller.
// Empty requested values use the caller. A different subject requires
// embed.impersonate. A different issuer is always rejected (cannot spoof iss).
func BindMintIdentity(callerIssuer, callerSubject, reqIssuer, reqSubject string, canImpersonate bool) (issuer, subject string, impersonating bool, err error) {
	callerIssuer = strings.TrimSpace(callerIssuer)
	callerSubject = strings.TrimSpace(callerSubject)
	reqIssuer = strings.TrimSpace(reqIssuer)
	reqSubject = strings.TrimSpace(reqSubject)

	issuer = callerIssuer
	if reqIssuer != "" && reqIssuer != callerIssuer {
		return "", "", false, ErrMintIssuerSpoof
	}

	subject = callerSubject
	if reqSubject != "" && reqSubject != callerSubject {
		if !canImpersonate {
			return "", "", false, ErrMintImpersonation
		}
		subject = reqSubject
		impersonating = true
	}
	return issuer, subject, impersonating, nil
}
