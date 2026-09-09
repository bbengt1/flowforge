package embed

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
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
		Kty:    KeyType,
		Crv:    Curve,
		X:      k.X,
		Kid:    k.Kid,
		Use:    "sig",
		Alg:    Algorithm,
		Status: KeyStatusOverlap,
	}, nil
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

// OverlapStillValid reports whether an optional overlap expiry is still open.
func OverlapStillValid(expiresAt time.Time, now time.Time) bool {
	if expiresAt.IsZero() {
		return true
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	return expiresAt.After(now.UTC())
}

// ParseIssuerAllowlist builds the optional iss allowlist from EMBED_ISSUER
// and EMBED_ISSUER_ALLOWLIST. Empty means any ValidIssuer is accepted.
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

func issuerAllowed(iss string, allow []string) bool {
	if len(allow) == 0 {
		return true
	}
	iss = strings.TrimSpace(iss)
	for _, a := range allow {
		if iss == strings.TrimSpace(a) {
			return true
		}
	}
	return false
}
