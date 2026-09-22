package mfa

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

// LoadKey reads MFA_SECRET_KEY. Empty is not an error: the process
// still boots, and MFA consumers fail closed. A present but malformed
// value is a boot-fail. The error never includes the key.
func LoadKey() ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv(EnvSecretKey))
	if raw == "" {
		return nil, nil
	}
	key, err := decodeKey(raw)
	if err != nil {
		return nil, fmt.Errorf("%s is malformed", EnvSecretKey)
	}
	return key, nil
}

func decodeKey(raw string) ([]byte, error) {
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
	return nil, ErrInvalid
}
