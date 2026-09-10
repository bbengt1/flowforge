package embed

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// KeyStatus values. E11.2 accepts only active and explicitly overlapping
// verification keys. E11.1 signs and verifies with the active key only.
const (
	KeyStatusActive  = "active"
	KeyStatusOverlap = "overlap"
)

// PublicJWK is a JWKS OKP/Ed25519 public key. The private parameter `d`
// is never populated.
//
// OverlapUntil is required on overlap verification keys (status=overlap).
// Missing or zero is refused on the verify path — it is not treated as
// forever. The active signing key is not an overlap key and does not
// carry overlapUntil; it stays valid until a new EMBED_SIGNING_KEY
// replaces it.
type PublicJWK struct {
	Kty          string    `json:"kty"`
	Crv          string    `json:"crv"`
	X            string    `json:"x"`
	Kid          string    `json:"kid"`
	Use          string    `json:"use"`
	Alg          string    `json:"alg"`
	Status       string    `json:"status"`
	OverlapUntil time.Time `json:"overlapUntil,omitempty"`
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

// Ephemeral reports whether this material is a process-local key that
// will not survive restart. Production must not use this path.
func (m Material) Ephemeral() bool {
	return strings.HasPrefix(strings.TrimSpace(m.KeyID), "ephemeral:")
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

// LoadMaterial reads EMBED_SIGNING_KEY, or EMBED_SIGNING_KEY_FILE when
// the env value is empty. The preferred private-key form is PKCS#8 PEM
// parsed with crypto/x509.ParsePKCS8PrivateKey (Ed25519). Production-locked
// processes (empty/production APP_ENV or REQUIRE_TLS) fail closed when
// the source is empty — no boot-only ephemeral key. Non-production
// APP_ENV (development|dev|local|test) without REQUIRE_TLS may mint an
// ephemeral process key via crypto/rand. There is no committed seed.
func LoadMaterial() (Material, error) {
	id := strings.TrimSpace(os.Getenv(EnvSigningKeyID))
	raw := strings.TrimSpace(os.Getenv(EnvSigningKey))
	if raw == "" {
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
	}
	overlap, err := LoadOverlapFromEnv()
	if err != nil {
		return Material{}, err
	}
	if raw == "" {
		if !allowEphemeralSigningKey() {
			return Material{}, fmt.Errorf("%w: set %s or %s (Ed25519 PKCS#8 PEM); empty APP_ENV/production and REQUIRE_TLS refuse a boot-only key",
				ErrSigningKeyRequired, EnvSigningKey, EnvSigningKeyFile)
		}
		m, err := generateEphemeralMaterial()
		if err != nil {
			return Material{}, err
		}
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

func allowEphemeralSigningKey() bool {
	return !authz.ProductionLockedFromEnv()
}

// NewEphemeralMaterial generates a process-local Ed25519 key for tests
// and trusted-dev. It is not a production key and is never the
// production LoadMaterial path. The key comes from crypto/rand only —
// there is no committed fallback seed.
func NewEphemeralMaterial() Material {
	m, err := generateEphemeralMaterial()
	if err != nil {
		panic(err)
	}
	if overlap, err := LoadOverlapFromEnv(); err == nil {
		m.Overlap = overlap
	}
	return m
}

func generateEphemeralMaterial() (Material, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Material{}, fmt.Errorf("generate ephemeral embed signing key: %w", err)
	}
	return Material{
		KeyID:   "ephemeral:process",
		Private: priv,
		Public:  pub,
		Status:  KeyStatusActive,
	}, nil
}

// TestMaterial generates a random non-production key for unit tests.
// Callers that need a stable fixture must reuse the returned Material
// (or write EncodePKCS8PEM to t.TempDir). It is never a production default.
func TestMaterial() Material {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(fmt.Sprintf("generate test embed signing key: %v", err))
	}
	return Material{
		KeyID:   "test:EMBED_SIGNING_KEY",
		Private: priv,
		Public:  pub,
		Status:  KeyStatusActive,
	}
}

func parsePrivateKey(raw string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	raw = normalizeKeyPEM(strings.TrimSpace(raw))
	if raw == "" {
		return nil, nil, fmt.Errorf("%s is empty", EnvSigningKey)
	}
	if strings.Contains(raw, "BEGIN") {
		return parsePEMPrivateKey(raw)
	}
	// Narrow compatibility for existing operator fixtures: raw 32-byte
	// Ed25519 seed or 64-byte private key as base64/hex. Prefer PKCS#8 PEM.
	if b, err := decodeLegacyKeyBytes(raw); err == nil {
		switch len(b) {
		case ed25519.SeedSize:
			priv := ed25519.NewKeyFromSeed(b)
			return priv, priv.Public().(ed25519.PublicKey), nil
		case ed25519.PrivateKeySize:
			priv := ed25519.PrivateKey(b)
			return priv, priv.Public().(ed25519.PublicKey), nil
		}
	}
	return nil, nil, fmt.Errorf("%s must be an Ed25519 PKCS#8 PEM (crypto/x509.ParsePKCS8PrivateKey); raw 32-byte seed / 64-byte key as base64 or hex is accepted only for compatibility", EnvSigningKey)
}

// normalizeKeyPEM turns a single-line env PEM (`\n` escapes) into a
// decodeable block. Real newlines are left unchanged.
func normalizeKeyPEM(raw string) string {
	if !strings.Contains(raw, "BEGIN") {
		return raw
	}
	if strings.Contains(raw, "\n") {
		return raw
	}
	if strings.Contains(raw, `\n`) {
		return strings.ReplaceAll(raw, `\n`, "\n")
	}
	return raw
}

func parsePEMPrivateKey(raw string) (ed25519.PrivateKey, ed25519.PublicKey, error) {
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return nil, nil, fmt.Errorf("%s PEM could not be decoded", EnvSigningKey)
	}
	switch block.Type {
	case "PRIVATE KEY":
		key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
		if err != nil {
			return nil, nil, fmt.Errorf("%s PKCS#8: %w", EnvSigningKey, err)
		}
		priv, ok := key.(ed25519.PrivateKey)
		if !ok {
			return nil, nil, fmt.Errorf("%s PKCS#8 is not an Ed25519 private key", EnvSigningKey)
		}
		return priv, priv.Public().(ed25519.PublicKey), nil
	case "PUBLIC KEY":
		if _, err := parsePKIXPublic(block.Bytes); err == nil {
			return nil, nil, fmt.Errorf("%s PEM is a public SPKI key; signing requires PKCS#8 private PEM", EnvSigningKey)
		}
		return nil, nil, fmt.Errorf("%s PEM is not an Ed25519 PKCS#8 private key", EnvSigningKey)
	default:
		return nil, nil, fmt.Errorf("%s PEM type %q is not PKCS#8 PRIVATE KEY", EnvSigningKey, block.Type)
	}
}

func parsePKIXPublic(der []byte) (ed25519.PublicKey, error) {
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := key.(ed25519.PublicKey)
	if !ok {
		return nil, fmt.Errorf("SPKI is not Ed25519")
	}
	return pub, nil
}

func parsePublicSPKIPEM(raw string) (ed25519.PublicKey, error) {
	raw = normalizeKeyPEM(strings.TrimSpace(raw))
	block, _ := pem.Decode([]byte(raw))
	if block == nil {
		return nil, fmt.Errorf("public SPKI PEM could not be decoded")
	}
	if block.Type != "PUBLIC KEY" {
		return nil, fmt.Errorf("public SPKI PEM type %q is not PUBLIC KEY", block.Type)
	}
	return parsePKIXPublic(block.Bytes)
}

func decodeLegacyKeyBytes(raw string) ([]byte, error) {
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

// EncodePKCS8PEM is the preferred helper for tests and operator docs.
// It is not an API. The PEM is PKCS#8 (`x509.MarshalPKCS8PrivateKey`).
func EncodePKCS8PEM(priv ed25519.PrivateKey) string {
	if len(priv) != ed25519.PrivateKeySize {
		return ""
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return ""
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

// EncodePKIXPublicPEM encodes an Ed25519 public key as SPKI PEM
// (`x509.MarshalPKIXPublicKey`). Overlap keys stay JWK; this is for
// PEM/file public material and tests.
func EncodePKIXPublicPEM(pub ed25519.PublicKey) string {
	if len(pub) != ed25519.PublicKeySize {
		return ""
	}
	der, err := x509.MarshalPKIXPublicKey(pub)
	if err != nil {
		return ""
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

// EncodeSeedB64 is the legacy raw-seed helper. Prefer EncodePKCS8PEM.
// Kept so leak-detection tests can still search for the old encoding.
func EncodeSeedB64(priv ed25519.PrivateKey) string {
	if len(priv) < ed25519.SeedSize {
		return ""
	}
	return base64.StdEncoding.EncodeToString(priv.Seed())
}
