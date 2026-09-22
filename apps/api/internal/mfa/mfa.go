// Package mfa is TOTP step-up for human sessions.
//
// The shared secret is encrypted at rest and returned only inside the
// one-time enroll otpauth URI. It is not a local-login password, not a
// machine secret, and not an embed assertion.
package mfa

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	// EnvSecretKey is the 32-byte AES key for TOTP secrets at rest.
	// Missing means enroll, verify, and privileged grants that need a
	// step-up fail closed. Malformed is a boot-fail.
	EnvSecretKey = "MFA_SECRET_KEY"

	secretSize = 20
	digits     = 6
	period     = 30
	issuerName = "FlowForge"
)

// Sentinel errors. Text is safe to log.
var (
	ErrNotConfigured = errors.New("mfa is not configured")
	ErrNotFound      = errors.New("mfa factor not found")
	ErrConflict      = errors.New("mfa factor already confirmed")
	ErrRejected      = errors.New("mfa code rejected")
	ErrUnavailable   = errors.New("mfa store unavailable")
	ErrInvalid       = errors.New("invalid mfa request")
)

// GenerateSecret returns a new TOTP shared secret.
func GenerateSecret() ([]byte, error) {
	buf := make([]byte, secretSize)
	if _, err := rand.Read(buf); err != nil {
		return nil, err
	}
	return buf, nil
}

// ProvisioningURI is the one-time otpauth URI for an authenticator app.
func ProvisioningURI(secret []byte, account string) string {
	account = strings.TrimSpace(account)
	if account == "" {
		account = "operator"
	}
	enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
	return fmt.Sprintf("otpauth://totp/%s:%s?secret=%s&issuer=%s&algorithm=SHA1&digits=%d&period=%d",
		url.PathEscape(issuerName), url.PathEscape(account), enc, url.QueryEscape(issuerName), digits, period)
}

// Code is the 6-digit TOTP for step (unix/30).
func Code(secret []byte, step int64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(step))
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", bin%1000000)
}

// Match accepts the current step and one step of clock skew, and
// rejects a step that is not newer than lastStep.
func Match(secret []byte, code string, now time.Time, lastStep int64) (int64, error) {
	code = strings.TrimSpace(code)
	if len(code) != digits {
		return 0, ErrRejected
	}
	for _, r := range code {
		if r < '0' || r > '9' {
			return 0, ErrRejected
		}
	}
	step := now.UTC().Unix() / period
	for _, delta := range []int64{-1, 0, 1} {
		candidate := step + delta
		if candidate <= 0 || candidate <= lastStep {
			continue
		}
		if hmac.Equal([]byte(Code(secret, candidate)), []byte(code)) {
			return candidate, nil
		}
	}
	return 0, ErrRejected
}

// Step is the current TOTP counter.
func Step(now time.Time) int64 {
	return now.UTC().Unix() / period
}
