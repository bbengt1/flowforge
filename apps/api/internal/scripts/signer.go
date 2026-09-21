package scripts

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/sha3"
)

// NewSigningKey returns a random 32-byte HMAC key for unit tests.
// It is not a production or compose default and is never used by
// LoadSigningKey.
func NewSigningKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic("generate test script signing key: " + err.Error())
	}
	return key
}

// LoadSigningKey reads SCRIPT_SIGNING_KEY. Missing or malformed values
// fail closed — the API must not mint a per-process random key. The
// returned error never includes the secret value.
func LoadSigningKey() ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv(EnvScriptSigningKey))
	if raw == "" {
		return nil, fmt.Errorf("%w: set %s (32-byte HMAC as base64 or 64 hex); the process refuses to start without a durable secret", ErrSigningKeyRequired, EnvScriptSigningKey)
	}
	key, err := parseSigningKey(raw)
	if err != nil {
		return nil, err
	}
	return key, nil
}

func parseSigningKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("%w: %s is empty", ErrSigningKeyRequired, EnvScriptSigningKey)
	}
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if b, err := hex.DecodeString(raw); err == nil && len(b) == 32 {
		return b, nil
	}
	if len(raw) == 32 {
		return []byte(raw), nil
	}
	return nil, fmt.Errorf("%w: %s must be 32 bytes (base64 or 64 hex)", ErrSigningKeyRequired, EnvScriptSigningKey)
}

// SignDigest returns hmac-sha256:<hex> over the content digest. The domain
// separator is mixed with SHA-3-256 so a job-ticket key cannot be reused as
// a script signature without the script domain.
func SignDigest(key []byte, digest string) (string, error) {
	if len(key) < 16 {
		return "", ErrSigningKey
	}
	digest = strings.TrimSpace(digest)
	if !strings.HasPrefix(digest, "sha256:") || len(digest) != 71 {
		return "", ErrInvalid
	}
	mac := hmac.New(sha256.New, deriveScriptMACKey(key))
	_, _ = mac.Write([]byte(digest))
	return SignaturePrefix + hex.EncodeToString(mac.Sum(nil)), nil
}

// VerifySignature reports whether signature is a valid HMAC for digest.
func VerifySignature(key []byte, digest, signature string) bool {
	want, err := SignDigest(key, digest)
	if err != nil {
		return false
	}
	return hmac.Equal([]byte(want), []byte(strings.TrimSpace(signature)))
}

func deriveScriptMACKey(key []byte) []byte {
	sum := sha3.Sum256(append([]byte("flowforge-script-artifact-v1\n"), key...))
	return sum[:]
}
