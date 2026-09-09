package authz

import "strings"

// Environment sources for the platform-admin allowlist. Empty means
// nobody may perform platform-scoped actions (fail closed).
const (
	EnvPlatformAdmins = "PLATFORM_ADMINS"
	EnvPlatformAdmin  = "PLATFORM_ADMIN"
)

// PrincipalRef is an issuer + external subject pair.
type PrincipalRef struct {
	Issuer  string
	Subject string
}

// ParsePlatformAdmins builds the platform-admin allowlist from
// PLATFORM_ADMINS (comma-separated issuer|subject) and optional
// PLATFORM_ADMIN (single pair). Empty input is fail-closed.
func ParsePlatformAdmins(allowlist, single string) []PrincipalRef {
	var out []PrincipalRef
	seen := map[string]struct{}{}
	add := func(raw string) {
		for _, part := range strings.Split(raw, ",") {
			ref, ok := parsePrincipalRef(part)
			if !ok {
				continue
			}
			key := ref.Issuer + "\x00" + ref.Subject
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			out = append(out, ref)
		}
	}
	add(allowlist)
	add(single)
	return out
}

func parsePrincipalRef(raw string) (PrincipalRef, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return PrincipalRef{}, false
	}
	issuer, subject, ok := strings.Cut(raw, "|")
	if !ok {
		return PrincipalRef{}, false
	}
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	if !ValidIssuer(issuer) || !ValidSubject(subject) {
		return PrincipalRef{}, false
	}
	return PrincipalRef{Issuer: issuer, Subject: subject}, true
}

// IsPlatformAdmin reports whether issuer+subject is on the allowlist.
// An empty allowlist is fail-closed.
func IsPlatformAdmin(issuer, subject string, allow []PrincipalRef) bool {
	issuer = strings.TrimSpace(issuer)
	subject = strings.TrimSpace(subject)
	if issuer == "" || subject == "" || len(allow) == 0 {
		return false
	}
	for _, ref := range allow {
		if issuer == ref.Issuer && subject == ref.Subject {
			return true
		}
	}
	return false
}
