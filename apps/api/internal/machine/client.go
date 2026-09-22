package machine

import (
	"crypto/rand"
	"encoding/hex"
	"strings"
	"unicode"
)

// NormalizeClientID lowercases a public client id. It is an identifier,
// not a secret.
func NormalizeClientID(raw string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(raw))
	if len(s) < 2 || len(s) > 64 {
		return "", ErrInvalid
	}
	if s[0] < 'a' || s[0] > 'z' {
		return "", ErrInvalid
	}
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return "", ErrInvalid
	}
	return s, nil
}

// NewClientID returns a public identifier when the operator omits one.
func NewClientID() (string, error) {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return "m-" + hex.EncodeToString(buf[:]), nil
}

// NormalizeDisplayName trims a display name. Empty and control
// characters are rejected.
func NormalizeDisplayName(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > 200 {
		return "", ErrInvalid
	}
	for _, r := range s {
		if unicode.IsControl(r) {
			return "", ErrInvalid
		}
	}
	return s, nil
}
