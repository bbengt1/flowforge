package embed

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// OverlapEnv is the JSON document accepted by EMBED_OVERLAP_KEYS:
// a JWKS object `{"keys":[...]}` or a bare array of public JWKs.
func LoadOverlapFromEnv() ([]PublicJWK, error) {
	return parseOverlapKeys(strings.TrimSpace(os.Getenv(EnvOverlapKeys)))
}

func parseOverlapKeys(raw string) ([]PublicJWK, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	var keys []PublicJWK
	if strings.HasPrefix(raw, "{") {
		var doc struct {
			Keys []PublicJWK `json:"keys"`
		}
		if err := json.Unmarshal([]byte(raw), &doc); err != nil {
			return nil, fmt.Errorf("%s: %w", EnvOverlapKeys, err)
		}
		keys = doc.Keys
	} else {
		if err := json.Unmarshal([]byte(raw), &keys); err != nil {
			return nil, fmt.Errorf("%s: %w", EnvOverlapKeys, err)
		}
	}
	out := make([]PublicJWK, 0, len(keys))
	seen := map[string]struct{}{}
	for _, k := range keys {
		norm, err := normalizeOverlapJWK(k)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", EnvOverlapKeys, err)
		}
		if err := validateOverlapUntil(norm.OverlapUntil, time.Now().UTC(), false); err != nil {
			return nil, fmt.Errorf("%s kid %q: %w", EnvOverlapKeys, norm.Kid, err)
		}
		if _, ok := seen[norm.Kid]; ok {
			return nil, fmt.Errorf("%s: duplicate kid %q", EnvOverlapKeys, norm.Kid)
		}
		seen[norm.Kid] = struct{}{}
		out = append(out, norm)
	}
	return out, nil
}

func normalizeOverlapJWK(k PublicJWK) (PublicJWK, error) {
	k.Kid = strings.TrimSpace(k.Kid)
	k.X = strings.TrimSpace(k.X)
	k.Kty = firstNonEmpty(k.Kty, KeyType)
	k.Crv = firstNonEmpty(k.Crv, Curve)
	k.Use = firstNonEmpty(k.Use, "sig")
	k.Alg = firstNonEmpty(k.Alg, Algorithm)
	k.Status = KeyStatusOverlap
	if k.Kid == "" || k.X == "" {
		return PublicJWK{}, fmt.Errorf("overlap key requires kid and x")
	}
	if k.Kty != KeyType || k.Crv != Curve || k.Alg != Algorithm {
		return PublicJWK{}, fmt.Errorf("overlap key %q must be OKP/Ed25519/EdDSA", k.Kid)
	}
	if _, err := decodePublicX(k.X); err != nil {
		return PublicJWK{}, fmt.Errorf("overlap key %q: %w", k.Kid, err)
	}
	// Never accept a private parameter even if an operator pasted a full JWK.
	return PublicJWK{
		Kty:          KeyType,
		Crv:          Curve,
		X:            k.X,
		Kid:          k.Kid,
		Use:          "sig",
		Alg:          Algorithm,
		Status:       KeyStatusOverlap,
		OverlapUntil: k.OverlapUntil.UTC(),
	}, nil
}

func filterLiveOverlap(keys []PublicJWK, now time.Time) []PublicJWK {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	out := make([]PublicJWK, 0, len(keys))
	seen := map[string]struct{}{}
	for _, k := range keys {
		k.Kid = strings.TrimSpace(k.Kid)
		if k.Kid == "" || !OverlapStillValid(k.OverlapUntil, now) {
			continue
		}
		if _, ok := seen[k.Kid]; ok {
			continue
		}
		seen[k.Kid] = struct{}{}
		out = append(out, k)
	}
	return out
}

func decodePublicX(x string) (ed25519.PublicKey, error) {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(x))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid Ed25519 public x")
	}
	return ed25519.PublicKey(b), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// ValidateOverlapUntil checks that until is a finite, short overlap
// window: required, in the future, and no longer than MaxOverlapTTL.
func ValidateOverlapUntil(until, now time.Time) error {
	return validateOverlapUntil(until, now, true)
}

func validateOverlapUntil(until, now time.Time, requireFuture bool) error {
	if until.IsZero() {
		return ErrOverlapUntilRequired
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	until = until.UTC()
	now = now.UTC()
	if requireFuture && !until.After(now) {
		return ErrOverlapUntilRequired
	}
	if until.After(now.Add(MaxOverlapTTL)) {
		return ErrOverlapUntilTooLong
	}
	return nil
}

// OverlapStillValid reports whether a required overlap expiry is still
// open. Zero (missing) and far-future windows are refused — they are
// not treated as forever. The active signing key is checked separately
// and does not use this helper.
func OverlapStillValid(expiresAt time.Time, now time.Time) bool {
	if expiresAt.IsZero() {
		return false
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	now = now.UTC()
	expiresAt = expiresAt.UTC()
	if !expiresAt.After(now) {
		return false
	}
	if expiresAt.After(now.Add(MaxOverlapTTL)) {
		return false
	}
	return true
}

// ParseIssuerAllowlist builds the iss allowlist from EMBED_ISSUER and
// EMBED_ISSUER_ALLOWLIST. Empty is fail-closed at mint and exchange
// (request-time 403). Compose seeds local issuers; production must set
// an explicit list. Production-locked processes also require every
// configured issuer to be an absolute https URI (ADV-018; boot-fail
// via ValidateIssuerAllowlist).
func ParseIssuerAllowlist(allowlist, single string) []string {
	var out []string
	seen := map[string]struct{}{}
	add := func(raw string) {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if _, ok := seen[part]; ok {
				continue
			}
			seen[part] = struct{}{}
			out = append(out, part)
		}
	}
	add(allowlist)
	add(single)
	return out
}

// HTTPSIssuer reports whether iss is an absolute https URI with a host.
// http, relative, protocol-relative, and opaque URIs are rejected.
func HTTPSIssuer(iss string) bool {
	iss = strings.TrimSpace(iss)
	if iss == "" {
		return false
	}
	u, err := url.Parse(iss)
	if err != nil {
		return false
	}
	if !strings.EqualFold(u.Scheme, "https") || u.Opaque != "" || u.Host == "" || u.User != nil {
		return false
	}
	return true
}

// ValidateIssuerAllowlist is the boot-time ADV-018 check. Empty is
// allowed (request-time 403, ADV-005). When requireHTTPS is set, every
// configured issuer must be an absolute https URI.
func ValidateIssuerAllowlist(issuers []string, requireHTTPS bool) error {
	if !requireHTTPS {
		return nil
	}
	for _, iss := range issuers {
		iss = strings.TrimSpace(iss)
		if iss == "" {
			continue
		}
		if !HTTPSIssuer(iss) {
			return fmt.Errorf("%w: %q", ErrIssuerNotHTTPS, iss)
		}
	}
	return nil
}

// IssuerAllowed reports whether iss may mint or exchange. An empty
// allowlist is fail-closed (no issuer is accepted). Production-locked
// processes (empty/production APP_ENV or REQUIRE_TLS) also require
// an absolute https URI (ADV-018).
func IssuerAllowed(iss string, allow []string) bool {
	iss = strings.TrimSpace(iss)
	if iss == "" || len(allow) == 0 {
		return false
	}
	if authz.ProductionLockedFromEnv() && !HTTPSIssuer(iss) {
		return false
	}
	for _, a := range allow {
		if iss == strings.TrimSpace(a) {
			return true
		}
	}
	return false
}
