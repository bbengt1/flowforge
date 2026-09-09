package vault

import (
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
)

const (
	// EnvKEK is the documented process environment source for the
	// 32-byte AES-256 key-encryption key. Value is standard/raw-URL
	// base64 or 64 hex characters. Never hard-code a production KEK.
	EnvKEK = "CREDENTIAL_KEK"
	// EnvKEKFile is an optional file path whose contents are parsed
	// the same way as CREDENTIAL_KEK (or as raw 32 bytes).
	EnvKEKFile = "CREDENTIAL_KEK_FILE"
	// EnvKEKID is stored as credentials.key_reference. Default names
	// the env source so operators can rotate by changing the id.
	EnvKEKID = "CREDENTIAL_KEK_ID"

	kekSize = 32
)

// Keys is the local envelope-encryption material for the MVP vault.
// Production should wrap this KEK with a KMS; the process still loads
// only the unwrapped 32-byte key from the environment.
type Keys struct {
	KEK []byte
	ID  string
}

// LoadKeys reads the KEK from the process environment. An empty source
// is valid: the API can start, but create/rotate/test/unlock fail closed.
func LoadKeys() (Keys, error) {
	id := strings.TrimSpace(os.Getenv(EnvKEKID))
	raw := strings.TrimSpace(os.Getenv(EnvKEK))
	if path := strings.TrimSpace(os.Getenv(EnvKEKFile)); path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return Keys{}, fmt.Errorf("%s: %w", EnvKEKFile, err)
		}
		raw = strings.TrimSpace(string(data))
		if id == "" {
			id = "file:" + EnvKEKFile
		}
		if len(data) == kekSize && raw == string(data) {
			return Keys{KEK: append([]byte(nil), data...), ID: id}, nil
		}
	}
	if raw == "" {
		return Keys{}, nil
	}
	kek, err := parseKEK(raw)
	if err != nil {
		return Keys{}, err
	}
	if id == "" {
		id = "env:" + EnvKEK
	}
	return Keys{KEK: kek, ID: id}, nil
}

// Ready reports whether encrypt/decrypt operations can run.
func (k Keys) Ready() bool {
	return len(k.KEK) == kekSize && strings.TrimSpace(k.ID) != ""
}

func parseKEK(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("%s is empty", EnvKEK)
	}
	if b, err := base64.StdEncoding.DecodeString(raw); err == nil && len(b) == kekSize {
		return b, nil
	}
	if b, err := base64.RawStdEncoding.DecodeString(raw); err == nil && len(b) == kekSize {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(raw); err == nil && len(b) == kekSize {
		return b, nil
	}
	if b, err := base64.RawURLEncoding.DecodeString(raw); err == nil && len(b) == kekSize {
		return b, nil
	}
	if b, err := hex.DecodeString(raw); err == nil && len(b) == kekSize {
		return b, nil
	}
	return nil, fmt.Errorf("%s must be 32 bytes as base64 or 64 hex characters", EnvKEK)
}

// TestKeys is a non-production AES-256 vector for unit tests only.
func TestKeys() Keys {
	kek := make([]byte, kekSize)
	for i := range kek {
		kek[i] = byte(i + 1)
	}
	return Keys{KEK: kek, ID: "test:CREDENTIAL_KEK"}
}
