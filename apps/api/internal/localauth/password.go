// Package localauth hashes and verifies standalone local-login passwords.
//
// V.0a door: email/username + password. Password material is POST-once
// and never echoed. Hashes never appear on identity.User or in JSON.
//
// OIDC Authorization Code + PKCE is deferred (V.0c). This package does
// not implement IdP start/callback or IdP-admin APIs.
package localauth

import (
	"errors"
	"strings"
	"unicode"

	"golang.org/x/crypto/bcrypt"
)

// Persistence / validation errors. Callers must not include the
// password or hash in problem details or logs.
var (
	ErrInvalidPassword   = errors.New("invalid password")
	ErrInvalidIdentifier = errors.New("invalid identifier")
)

const (
	// MinPasswordLength is the shortest accepted local password.
	MinPasswordLength = 8
	// MaxPasswordLength is bcrypt's 72-byte limit.
	MaxPasswordLength = 72
	// MaxIdentifierLength matches users.external_subject.
	MaxIdentifierLength = 256
)

var dummyHash []byte

func init() {
	hash, err := bcrypt.GenerateFromPassword([]byte("flowforge-dummy-verify"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}
	dummyHash = hash
}

// NormalizeIdentifier trims and lowercases an email or username.
func NormalizeIdentifier(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > MaxIdentifierLength {
		return "", ErrInvalidIdentifier
	}
	for _, r := range s {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return "", ErrInvalidIdentifier
		}
	}
	return strings.ToLower(s), nil
}

// ValidatePassword checks length only. It never returns the password.
func ValidatePassword(password string) error {
	if len(password) < MinPasswordLength || len(password) > MaxPasswordLength {
		return ErrInvalidPassword
	}
	for _, r := range password {
		if unicode.IsControl(r) && r != '\t' {
			return ErrInvalidPassword
		}
	}
	return nil
}

// HashPassword returns a bcrypt hash. The password is not retained.
func HashPassword(password string) (string, error) {
	if err := ValidatePassword(password); err != nil {
		return "", err
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// Verify compares password to a stored bcrypt hash. Unknown users
// should call DummyVerify so timing does not leak existence.
func Verify(password, hash string) bool {
	if hash == "" {
		DummyVerify(password)
		return false
	}
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// DummyVerify spends a bcrypt compare so a missing account does not
// return faster than a wrong password.
func DummyVerify(password string) {
	_ = bcrypt.CompareHashAndPassword(dummyHash, []byte(password))
}
