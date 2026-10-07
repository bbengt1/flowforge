package scim

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"regexp"
	"strings"
)

// Per-workspace SCIM bearer tokens. The plaintext is TokenPrefix
// followed by TokenRandomBytes of crypto/rand encoded as unpadded
// base64url (43 characters). It is shown once at creation and never
// stored, logged, or audited. The database keeps HashToken of the whole
// plaintext, prefix included. The prefix is not secret: it lets
// gitleaks and the log scrubber recognize a token, and the admin list
// may show it. The instance-wide SCIM_BEARER_TOKEN format is unchanged.
const (
	TokenPrefix      = "ffscim_"
	TokenRandomBytes = 32
	// MaxActiveTokens is the per-workspace limit on tokens that are not
	// revoked. A third create is 409 scim_token_limit.
	MaxActiveTokens = 2
)

// tokenPattern is the exact shape of a workspace token.
var tokenPattern = regexp.MustCompile(`^ffscim_[A-Za-z0-9_-]{43}$`)

// tokenInText finds a workspace token anywhere in a string.
var tokenInText = regexp.MustCompile(`ffscim_[A-Za-z0-9_-]{20,}`)

// NewToken returns a fresh plaintext workspace token.
func NewToken() (string, error) {
	buf := make([]byte, TokenRandomBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return TokenPrefix + base64.RawURLEncoding.EncodeToString(buf), nil
}

// HashToken is the stored lookup key: lowercase hex SHA-256 of the
// whole presented string, prefix included.
func HashToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// IsWorkspaceToken reports whether a presented bearer has the workspace
// token prefix. Such a bearer is only ever looked up as a workspace
// token; it is never compared to SCIM_BEARER_TOKEN.
func IsWorkspaceToken(presented string) bool {
	return strings.HasPrefix(presented, TokenPrefix)
}

// WellFormedToken reports whether s is exactly a workspace token. A
// prefixed bearer that is not well formed is 401 without a lookup.
func WellFormedToken(s string) bool {
	return tokenPattern.MatchString(s)
}

// ContainsToken reports whether s carries something shaped like a
// workspace token anywhere. Log and audit scrubbers use it.
func ContainsToken(s string) bool {
	return strings.Contains(s, TokenPrefix) && tokenInText.MatchString(s)
}
