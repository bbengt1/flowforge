package bootstrap

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode"

	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
)

// EnvSetupToken is the optional compose/dev setup token. When unset,
// the API generates one while the admin password is unset and prints
// that plaintext once. This value is never written to the database.
const EnvSetupToken = "FLOWFORGE_SETUP_TOKEN"

const (
	// DefaultSetupIPLimit is the per-IP budget for
	// POST /bootstrap/admin-password. A negative limit is unlimited.
	DefaultSetupIPLimit = 10
	// DefaultSetupWindow is the fixed window for that budget.
	DefaultSetupWindow = time.Minute

	minSetupTokenLength = 16
	maxSetupTokenLength = 256
)

// ErrSetupTokenInvalid is a malformed operator-supplied token.
// The error text never includes the value.
var ErrSetupTokenInvalid = errors.New("setup token is not valid")

// GenerateSetupToken returns a fresh high-entropy token. Callers print
// it once and store only HashSetupToken.
func GenerateSetupToken() (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashSetupToken returns the lowercase SHA-256 hex digest. The token
// is not retained.
func HashSetupToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ValidSetupTokenHash reports whether hash is 64 lowercase hex chars.
func ValidSetupTokenHash(hash string) bool {
	if len(hash) != sha256.Size*2 {
		return false
	}
	for _, c := range hash {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		default:
			return false
		}
	}
	return true
}

// ValidateSetupToken accepts an empty value (the API will generate one)
// or a token that is long enough and is not the retired default password.
func ValidateSetupToken(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if len(raw) < minSetupTokenLength || len(raw) > maxSetupTokenLength {
		return ErrSetupTokenInvalid
	}
	if raw == localauth.OneTimePassword {
		return ErrSetupTokenInvalid
	}
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return ErrSetupTokenInvalid
		}
	}
	return nil
}

// SetupIPKey is the rate-limit key for POST /bootstrap/admin-password.
// Prefixed so it never shares the login or embed budget.
func SetupIPKey(ip string) string {
	ip = strings.TrimSpace(ip)
	if ip == "" {
		return "setup:ip:unknown"
	}
	return "setup:ip:" + ip
}

func setupHashEqual(stored, presented string) bool {
	if len(stored) != len(presented) || stored == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(stored), []byte(presented)) == 1
}
