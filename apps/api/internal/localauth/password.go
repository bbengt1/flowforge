// Package localauth hashes and verifies standalone local-login passwords.
//
// V.0a door: email/username + password. Password material is POST-once
// and never echoed. Hashes never appear on identity.User or in JSON.
//
// OIDC Authorization Code + PKCE lives in package oidc. This package
// does not implement IdP start/callback or MFA.
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
	// ErrReusedPassword is a replacement that matches the current secret.
	ErrReusedPassword = errors.New("reused password")
	// ErrOneTimePassword is a replacement that matches the first-run default.
	ErrOneTimePassword = errors.New("one-time password")
)

const (
	// MinPasswordLength is the shortest accepted local password.
	MinPasswordLength = 8
	// MaxPasswordLength is bcrypt's 72-byte limit.
	MaxPasswordLength = 72
	// MaxIdentifierLength matches users.external_subject.
	MaxIdentifierLength = 256

	// OneTimeIdentifier is the documented first-run operator.
	// Seeded only when local_logins is empty; never overwrites.
	OneTimeIdentifier = "admin"
	// OneTimePassword is the documented first-run password. It is
	// shorter than MinPasswordLength and is rejected as a replacement.
	// Never log or echo this value.
	OneTimePassword = "admin"
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
	return hashPassword(password)
}

// HashOneTimePassword hashes the documented first-run password without
// applying the normal minimum length. Used only by the empty-table seed.
func HashOneTimePassword() (string, error) {
	if OneTimePassword == "" || len(OneTimePassword) > MaxPasswordLength {
		return "", ErrInvalidPassword
	}
	return hashPassword(OneTimePassword)
}

func hashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

// IsOneTimePassword reports whether password is the documented first-run
// default. Comparison is exact; callers must not log the value.
func IsOneTimePassword(password string) bool {
	return password == OneTimePassword
}

// ValidateReplacementPassword checks a change-password value: min length,
// not the current password, and not the one-time default.
func ValidateReplacementPassword(password, current string) error {
	if IsOneTimePassword(password) {
		return ErrOneTimePassword
	}
	if err := ValidatePassword(password); err != nil {
		return err
	}
	if current != "" && password == current {
		return ErrReusedPassword
	}
	return nil
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
