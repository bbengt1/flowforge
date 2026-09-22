package oidc

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
)

const (
	verifierBytes = 32
	stateBytes    = 32
	nonceBytes    = 32
)

func newVerifier() (string, error) {
	return randomRawURL(verifierBytes)
}

func newState() (string, error) {
	return randomRawURL(stateBytes)
}

func newNonce() (string, error) {
	return randomRawURL(nonceBytes)
}

func randomRawURL(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}

// S256Challenge is BASE64URL(SHA256(verifier)) without padding (RFC 7636).
func S256Challenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func newUUID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:]), nil
}
