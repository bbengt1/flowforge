package machine

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"
	"unicode"
)

const (
	assertionTyp    = "machine-assertion"
	assertionMaxTTL = 5 * time.Minute
	assertionLeeway = 30 * time.Second
	maxAssertionLen = 4096
)

type assertionHeader struct {
	Alg string `json:"alg"`
	Typ string `json:"typ"`
}

type assertionClaims struct {
	Iss string `json:"iss"`
	Sub string `json:"sub"`
	Aud string `json:"aud"`
	Exp int64  `json:"exp"`
	Nbf int64  `json:"nbf"`
	JTI string `json:"jti"`
}

// SignAssertion builds a short-lived Ed25519 assertion. The private
// key stays with the caller; the server stores only the public key.
func SignAssertion(priv ed25519.PrivateKey, clientID string, now time.Time, ttl time.Duration) (string, error) {
	if len(priv) != ed25519.PrivateKeySize {
		return "", ErrInvalid
	}
	clientID = strings.TrimSpace(clientID)
	if _, err := NormalizeClientID(clientID); err != nil {
		return "", err
	}
	if ttl <= 0 || ttl > assertionMaxTTL {
		return "", ErrInvalid
	}
	now = now.UTC()
	jti, err := newJTI()
	if err != nil {
		return "", err
	}
	h := assertionHeader{Alg: "EdDSA", Typ: assertionTyp}
	c := assertionClaims{
		Iss: Issuer,
		Sub: clientID,
		Aud: Audience,
		Exp: now.Add(ttl).Unix(),
		Nbf: now.Unix(),
		JTI: jti,
	}
	hb, err := json.Marshal(h)
	if err != nil {
		return "", err
	}
	pb, err := json.Marshal(c)
	if err != nil {
		return "", err
	}
	input := b64(hb) + "." + b64(pb)
	sig := ed25519.Sign(priv, []byte(input))
	return input + "." + b64(sig), nil
}

// VerifyAssertion checks signature, audience, expiry, and client id.
// It does not consume jti; the caller must.
func VerifyAssertion(pub ed25519.PublicKey, compact, clientID string, now time.Time) (string, time.Time, error) {
	compact = strings.TrimSpace(compact)
	clientID = strings.TrimSpace(clientID)
	if len(pub) != ed25519.PublicKeySize || compact == "" || len(compact) > maxAssertionLen {
		return "", time.Time{}, ErrCredential
	}
	parts := strings.Split(compact, ".")
	if len(parts) != 3 {
		return "", time.Time{}, ErrCredential
	}
	hb, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", time.Time{}, ErrCredential
	}
	pb, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", time.Time{}, ErrCredential
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "", time.Time{}, ErrCredential
	}
	input := parts[0] + "." + parts[1]
	if !ed25519.Verify(pub, []byte(input), sig) {
		return "", time.Time{}, ErrCredential
	}
	var h assertionHeader
	if err := json.Unmarshal(hb, &h); err != nil || h.Alg != "EdDSA" || h.Typ != assertionTyp {
		return "", time.Time{}, ErrCredential
	}
	var c assertionClaims
	if err := json.Unmarshal(pb, &c); err != nil {
		return "", time.Time{}, ErrCredential
	}
	if c.Iss != Issuer || c.Aud != Audience || c.Sub != clientID {
		return "", time.Time{}, ErrCredential
	}
	if !validJTI(c.JTI) || c.Exp <= 0 {
		return "", time.Time{}, ErrCredential
	}
	now = now.UTC()
	exp := time.Unix(c.Exp, 0).UTC()
	nbf := time.Unix(c.Nbf, 0).UTC()
	if c.Nbf > 0 && now.Add(assertionLeeway).Before(nbf) {
		return "", time.Time{}, ErrCredential
	}
	if !now.Before(exp) {
		return "", time.Time{}, ErrCredential
	}
	span := exp.Sub(nbf)
	if c.Nbf <= 0 {
		span = exp.Sub(now)
	}
	if span <= 0 || span > assertionMaxTTL {
		return "", time.Time{}, ErrCredential
	}
	return c.JTI, exp, nil
}

// ParsePublicKey accepts a standard or raw base64 Ed25519 public key.
// PEM and private-key lengths are rejected and not stored.
func ParsePublicKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || strings.Contains(raw, "PRIVATE") || strings.Contains(raw, "-----") {
		return nil, ErrInvalid
	}
	b, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		b, err = base64.RawStdEncoding.DecodeString(raw)
	}
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil, ErrInvalid
	}
	return b, nil
}

func b64(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func newJTI() (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "mj_" + base64.RawURLEncoding.EncodeToString(buf[:]), nil
}

func validJTI(s string) bool {
	if len(s) < 16 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}
