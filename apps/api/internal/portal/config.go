package portal

import (
	"net/url"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/embed"
)

// Config is the Portal integration-boundary settings.
type Config struct {
	Issuers        []string
	FrameAncestors []string
}

// ParseIssuers builds the Portal issuer allowlist from PORTAL_ISSUER and
// PORTAL_ISSUER_ALLOWLIST. Empty is fail-closed at Portal mint (request-time
// 403). Compose seeds a local issuer; production must set an explicit list.
func ParseIssuers(allowlist, single string) []string {
	return embed.ParseIssuerAllowlist(allowlist, single)
}

// IssuerAllowed reports whether iss may mint through the Portal adapter.
// An empty allowlist is fail-closed.
func IssuerAllowed(iss string, allow []string) bool {
	return embed.IssuerAllowed(iss, allow)
}

// ParseFrameAncestors parses exact http(s) origins. "*" and "null" are ignored.
func ParseFrameAncestors(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	var out []string
	seen := map[string]struct{}{}
	for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		part = strings.TrimSpace(part)
		if part == "" || part == "*" || strings.EqualFold(part, "null") {
			continue
		}
		u, err := url.Parse(part)
		if err != nil || u.Host == "" || u.User != nil {
			continue
		}
		if u.Scheme != "https" && u.Scheme != "http" {
			continue
		}
		normalized := u.Scheme + "://" + u.Host
		if _, ok := seen[normalized]; ok {
			continue
		}
		seen[normalized] = struct{}{}
		out = append(out, normalized)
	}
	return out
}
