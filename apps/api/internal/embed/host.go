package embed

import "strings"

// Exchange host-issuer binding (ADV-023). iss is already the minting
// caller (ADV-004). Exchange must also bind that iss to the host
// context that is performing the exchange — Portal-framed vs standalone
// embed — not merely “any issuer on the merged allowlist.”
const (
	HeaderHostIssuer  = "X-FlowForge-Host-Issuer"
	HeaderHostContext = "X-FlowForge-Host-Context"
	HostContextEmbed  = "embed"
	HostContextPortal = "portal"
)

// HostBinding is the expected minting host issuer for one exchange.
// Issuer is the configured Portal or embed issuer for this frame — never
// a value peeked from the assertion. Context selects the path allowlist
// (portal vs embed). Empty context uses the merged allowlist.
type HostBinding struct {
	Issuer  string
	Context string
}

// ResolveHostBinding merges header and body host-issuer fields.
// Header and body must agree when both are set. Unknown context is
// rejected. Chloe should send the configured host issuer, not iss.
func ResolveHostBinding(headerIssuer, headerContext, bodyIssuer, bodyContext string) (HostBinding, error) {
	hi := strings.TrimSpace(headerIssuer)
	bi := strings.TrimSpace(bodyIssuer)
	if hi != "" && bi != "" && hi != bi {
		return HostBinding{}, ErrHostIssuer
	}
	issuer := hi
	if issuer == "" {
		issuer = bi
	}

	hc := strings.ToLower(strings.TrimSpace(headerContext))
	bc := strings.ToLower(strings.TrimSpace(bodyContext))
	if hc != "" && bc != "" && hc != bc {
		return HostBinding{}, ErrHostIssuer
	}
	ctx := hc
	if ctx == "" {
		ctx = bc
	}
	if ctx != "" && ctx != HostContextEmbed && ctx != HostContextPortal {
		return HostBinding{}, ErrHostContext
	}
	return HostBinding{Issuer: issuer, Context: ctx}, nil
}

// MergeIssuers concatenates issuer allowlists, dropping blanks and
// duplicates while preserving first-seen order.
func MergeIssuers(lists ...[]string) []string {
	seen := map[string]struct{}{}
	var out []string
	for _, list := range lists {
		for _, iss := range list {
			iss = strings.TrimSpace(iss)
			if iss == "" {
				continue
			}
			if _, ok := seen[iss]; ok {
				continue
			}
			seen[iss] = struct{}{}
			out = append(out, iss)
		}
	}
	return out
}

// HostAllowlist returns the issuer allowlist for an exchange host
// context. portal uses PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST only;
// embed uses EMBED_ISSUER / EMBED_ISSUER_ALLOWLIST only; empty context
// merges both. An empty selected list fails closed at BindHostIssuer.
func HostAllowlist(context string, embedIssuers, portalIssuers []string) []string {
	switch strings.ToLower(strings.TrimSpace(context)) {
	case HostContextPortal:
		return append([]string(nil), portalIssuers...)
	case HostContextEmbed:
		return append([]string(nil), embedIssuers...)
	default:
		return MergeIssuers(embedIssuers, portalIssuers)
	}
}

// BindHostIssuer binds a verified assertion iss to the minting host
// issuer context (ADV-023).
//
//  1. When the host claim is present it must equal iss (mint writes
//     host=iss). A mismatch is 403.
//  2. When the exchange declares an expected host issuer, iss must
//     equal that value. Wrong-issuer-for-host is 403.
//  3. When no expected issuer is declared and more than one issuer is
//     on the selected allowlist, exchange fails closed — the host
//     context is ambiguous (typical when both embed and Portal lists
//     are configured). A single configured issuer stays compatible
//     without a header.
//  4. iss must still be on the selected allowlist (empty fails closed).
func BindHostIssuer(iss, hostClaim, expected string, allow []string) error {
	iss = strings.TrimSpace(iss)
	hostClaim = strings.TrimSpace(hostClaim)
	expected = strings.TrimSpace(expected)
	if hostClaim != "" && hostClaim != iss {
		return ErrHostIssuer
	}
	if expected != "" && expected != iss {
		return ErrHostIssuer
	}
	if expected == "" && distinctIssuers(allow) > 1 {
		return ErrHostIssuer
	}
	if !IssuerAllowed(iss, allow) {
		return ErrIssuerNotAllowed
	}
	return nil
}

func distinctIssuers(allow []string) int {
	return len(MergeIssuers(allow))
}
