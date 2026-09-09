package embed

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
)

// KeyStatus values. E11.2 accepts only active and explicitly overlapping
// verification keys. E11.1 signs and verifies with the active key only.
const (
	KeyStatusActive  = "active"
	KeyStatusOverlap = "overlap"
)

// PublicJWK is a JWKS OKP/Ed25519 public key. The private parameter `d`
// is never populated.
type PublicJWK struct {
	Kty    string `json:"kty"`
	Crv    string `json:"crv"`
	X      string `json:"x"`
	Kid    string `json:"kid"`
	Use    string `json:"use"`
	Alg    string `json:"alg"`
	Status string `json:"status"`
}

// Material is the process signing key. Private bytes stay in memory and
// are never marshaled to JSON.
type Material struct {
	KeyID   string
	Private ed25519.PrivateKey
	Public  ed25519.PublicKey
	Status  string
	// Overlap is the E11.2 verification-only hook. E11.1 leaves it empty
	// and Verify rejects unknown kids fail-closed.
	Overlap []PublicJWK
}

// Ready reports whether mint/verify can run.
func (m Material) Ready() bool {
	return len(m.Private) == ed25519.PrivateKeySize &&
		len(m.Public) == ed25519.PublicKeySize &&
		strings.TrimSpace(m.KeyID) != ""
}

// PublicKeys returns JWKS keys. Never includes private material.
func (m Material) PublicKeys() []PublicJWK {
	var out []PublicJWK
	if m.Ready() {
		out = append(out, PublicJWK{
			Kty:    KeyType,
			Crv:    Curve,
			X:      base64.RawURLEncoding.EncodeToString(m.Public),
			Kid:    m.KeyID,
			Use:    "sig",
			Alg:    Algorithm,
			Status: KeyStatusActive,
		})
	}
	out = append(out, m.Overlap...)
	return out
}

// JWKS is the public JSON Web Key Set.
type JWKS struct {
	Keys         []PublicJWK `json:"keys"`
	SigningReady bool        `json:"signingReady"`
}

// PublicJWKS never includes private keys or PEM.
func (m Material) PublicJWKS() JWKS {
	keys := m.PublicKeys()
	if keys == nil {
		keys = []PublicJWK{}
	}
	return JWKS{Keys: keys, SigningReady: m.Ready()}
}

// MarshalJSON on Material is fail-closed: only public JWKS is emitted.
func (m Material) MarshalJSON() ([]byte, error) {
	return json.Marshal(m.PublicJWKS())
}

// LoadMaterial reads EMBED_SIGNING_KEY / FILE. An empty source yields an
// ephemeral process key so local mint works; production must set a stable key.
func LoadMaterial() (Material, error) {
	id := strings.TrimSpace(os.Getenv(EnvSigningKeyID))
	raw := strings.TrimSpace(os.Getenv(EnvSigningKey))
	if path := strings.TrimSpace(os.Getenv(EnvSigningKeyFile)); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return Material{}, fmt.Errorf("%s: %w", EnvSigningKeyFile, err)
		}
		raw = strings.TrimSpace(string(data))
		if id == "" {
			id = "file:" + EnvSigningKeyFile
		}
	}
	overlap, err := LoadOverlapFromEnv()
	if err != nil {
		return Material{}, err
	}
	if raw == "" {
		m := NewEphemeralMaterial()
		m.Overlap = overlap
		return m, nil
	}
	priv, pub, err := parsePrivateKey(raw)
	if err != nil {
		return Material{}, err
	}
	if id == "" {
		id = "env:" + EnvSigningKey
	}
	return Material{
		KeyID:   id,
		Private: priv,
		Public:  pub,
		Status:  KeyStatusActive,
		Overlap: overlap,
	}, nil
}

// NewEphemeralMaterial generates a process-local Ed25519 key.
func NewEphemeralMaterial() Material {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		// Deterministic fallback so tests/boot never panic; still not a
		// production key and never returned from an API.
		seed := make([]byte, ed25519.SeedSize)
		copy(seed, []byte("flowforge-embed-ephemeral-seed"))
		priv = ed25519.NewKeyFromSeed(seed)
		pub = priv.Public().(ed25519.PublicKey)
	}
	m := Material{
		KeyID:   "ephemeral:process",
		Private: priv,
		Public:  pub,
		Status:  KeyStatusActive,
	}
	if overlap, err := LoadOverlapFromEnv(); err == nil {
		m.Overlap = overlap
	}
	return m
}

// TestMaterial is a fixed non-production key for unit tests.
func TestMaterial() Material {
	seed := make([]byte, ed25519.SeedSize)
	for i := range seed {
		seed[i] = byte(i + 3)
	}
	priv := ed25519.NewKeyFromSeed(seed)
	return Material{
		KeyID:   "test:EMBED_SIGNING_KEY",
		Private: priv,
		Public:  priv.Public().(ed25519.PublicKey),
		Status:  KeyStatusActive,
	}
}

func parsePrivateKey(raw string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil, fmt.Errorf("%s is empty", EnvSigningKey)
	}
	if strings.Contains(raw, "BEGIN") {
		block, _ := pem.Decode([]byte(raw))
		if block == nil {
			return nil, nil, fmt.Errorf("%s PEM could not be decoded", EnvSigningKey)
		}
		if k, err := parsePKCS8Ed25519(block.Bytes); err == nil {
			return k, k.Public().(ed25519.PublicKey), nil
		}
		if len(block.Bytes) == ed25519.SeedSize {
			priv := ed25519.NewKeyFromSeed(block.Bytes)
			return priv, priv.Public().(ed25519.PublicKey), nil
		}
		if len(block.Bytes) == ed25519.PrivateKeySize {
			priv := ed25519.PrivateKey(append([]byte(nil), block.Bytes...))
			return priv, priv.Public().(ed25519.PublicKey), nil
		}
		return nil, nil, fmt.Errorf("%s PEM is not an Ed25519 private key", EnvSigningKey)
	}
	if b, err := decodeKeyBytes(raw); err == nil {
		switch len(b) {
		case ed25519.SeedSize:
			priv := ed25519.NewKeyFromSeed(b)
			return priv, priv.Public().(ed25519.PublicKey), nil
		case ed25519.PrivateKeySize:
			priv := ed25519.PrivateKey(b)
			return priv, priv.Public().(ed25519.PublicKey), nil
		}
	}
	return nil, nil, fmt.Errorf("%s must be an Ed25519 seed (32 bytes) or private key (64 bytes) as base64, hex, or PKCS8 PEM", EnvSigningKey)
}

func decodeKeyBytes(raw string) ([]byte, error) {
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && (len(b) == ed25519.SeedSize || len(b) == ed25519.PrivateKeySize) {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(raw); err == nil && (len(b) == ed25519.SeedSize || len(b) == ed25519.PrivateKeySize) {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(raw); err == nil && (len(b) == ed25519.SeedSize || len(b) == ed25519.PrivateKeySize) {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(raw); err == nil && (len(b) == ed25519.SeedSize || len(b) == ed25519.PrivateKeySize) {
		return b, nil
	}
	if b, err := hex.DecodeString(raw); err == nil && (len(b) == ed25519.SeedSize || len(b) == ed25519.PrivateKeySize) {
		return b, nil
	}
	return nil, fmt.Errorf("unrecognized key encoding")
}

func parsePKCS8Ed25519(der []byte) (ed25519.PrivateKey, error) {
	// Minimal PKCS#8 parse for Ed25519: OCTET STRING seed after the
	// algorithm OID. Avoids adding x509-only failure modes for raw keys.
	const seedLen = ed25519.SeedSize
	if len(der) >= seedLen {
		// Look for a 32-byte OCTET STRING (0x04 0x20 <seed>).
		for i := 0; i+2+seedLen <= len(der); i++ {
			if der[i] == 0x04 && der[i+1] == 0x20 {
				seed := der[i+2 : i+2+seedLen]
				return ed25519.NewKeyFromSeed(seed), nil
			}
		}
	}
	return nil, fmt.Errorf("pkcs8 ed25519 seed not found")
}

// EncodeSeedB64 is a helper for tests and operator docs. It is not an API.
func EncodeSeedB64(priv ed25519.PrivateKey) string {
	if len(priv) < ed25519.SeedSize {
		return ""
	}
	return base64.StdEncoding.EncodeToString(priv.Seed())
}
