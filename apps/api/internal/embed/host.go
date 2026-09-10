package embed

import "strings"

// Exchange host-issuer binding (ADV-023). iss is already the minting
// caller (ADV-004). The minting host path is a signed claim (`ctx`:
// portal vs embed) so exchange does not trust an unauthenticated
// request header as the expected issuer. Client headers are an optional
// consistency check for the honest embed shell.
const (
	HeaderHostIssuer  = "X-FlowForge-Host-Issuer"
	HeaderHostContext = "X-FlowForge-Host-Context"
	HostContextEmbed  = "embed"
	HostContextPortal = "portal"
	ClaimContext      = "ctx"
)

// HostBinding is an optional exchange request consistency check.
// Issuer/Context come from X-FlowForge-Host-Issuer / hostContext.
// They must agree with the signed assertion when present; they are
// never the sole source of the expected host.
type HostBinding struct {
	Issuer  string
	Context string
}

// ResolveHostBinding merges header and body host-issuer fields.
// Header and body must agree when both are set. Unknown context is
// rejected.
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

// NormalizeHostContext accepts portal|embed or empty. Anything else is
// ErrHostContext.
func NormalizeHostContext(raw string) (string, error) {
	ctx := strings.ToLower(strings.TrimSpace(raw))
	if ctx == "" {
		return "", nil
	}
	if ctx != HostContextEmbed && ctx != HostContextPortal {
		return "", ErrHostContext
	}
	return ctx, nil
}

// ResolveSignedHostContext picks the path allowlist context from the
// signed `ctx` claim, then an optional client declaration. A client
// context that disagrees with the signed claim is 403. The signed
// claim wins when the client omits context.
func ResolveSignedHostContext(signed, declared string) (string, error) {
	sig, err := NormalizeHostContext(signed)
	if err != nil {
		return "", err
	}
	dec, err := NormalizeHostContext(declared)
	if err != nil {
		return "", err
	}
	if sig != "" && dec != "" && sig != dec {
		return "", ErrHostIssuer
	}
	if sig != "" {
		return sig, nil
	}
	return dec, nil
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

// HostAllowlist returns the issuer allowlist for a minting host path.
// portal uses PORTAL_* only; embed uses EMBED_* only; empty context
// merges both (legacy tokens without a signed ctx).
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

// BindHostIssuer binds a verified assertion iss to the minting host.
//
//  1. When the host claim is present it must equal iss (mint writes
//     host=iss). A mismatch is 403.
//  2. When the exchange declares an expected host issuer (honest
//     embed shell), iss must equal that value. Wrong-issuer-for-host
//     is 403. A missing declaration is not fail-open for path bind —
//     the signed ctx claim selects the allowlist.
//  3. iss must be on the selected path allowlist (empty fails closed).
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
	if !IssuerAllowed(iss, allow) {
		return ErrIssuerNotAllowed
	}
	return nil
}
