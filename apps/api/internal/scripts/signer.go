package scripts

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"strings"

	"golang.org/x/crypto/sha3"
)

// NewSigningKey returns a random 32-byte HMAC key. Used when the process
// environment does not set SCRIPT_SIGNING_KEY (local/tests).
func NewSigningKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		sum := sha256.Sum256([]byte("flowforge-ephemeral-script-signing"))
		return sum[:]
	}
	return key
}

// LoadSigningKey reads SCRIPT_SIGNING_KEY or generates an ephemeral key.
func LoadSigningKey() []byte {
	raw := strings.TrimSpace(os.Getenv(EnvScriptSigningKey))
	if raw == "" {
		return NewSigningKey()
	}
	if key, err := parseSigningKey(raw); err == nil {
		return key
	}
	return NewSigningKey()
}

func parseSigningKey(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, ErrSigningKey
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
	return nil, ErrSigningKey
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
