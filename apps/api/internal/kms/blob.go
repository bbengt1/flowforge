package kms

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
)

const (
	blobPrefix   = "ff1"
	maxKeyID     = 2048
	maxCipher    = 8192
	maxBlobRunes = 16384
)

// EncodeBlob packs provider, key id, and KMS ciphertext for
// CREDENTIAL_KEK_WRAPPED. The result contains no plaintext KEK.
func EncodeBlob(provider, keyID string, ciphertext []byte) (string, error) {
	if !knownProvider(provider) {
		return "", fmt.Errorf("wrapped KEK provider is invalid")
	}
	if !validKeyID(keyID) {
		return "", fmt.Errorf("wrapped KEK key id is invalid")
	}
	if len(ciphertext) == 0 || len(ciphertext) > maxCipher {
		return "", fmt.Errorf("wrapped KEK ciphertext is invalid")
	}
	out := blobPrefix + ":" + provider + ":" +
		base64.RawURLEncoding.EncodeToString([]byte(keyID)) + ":" +
		base64.RawURLEncoding.EncodeToString(ciphertext)
	if len(out) > maxBlobRunes {
		return "", fmt.Errorf("wrapped KEK ciphertext is invalid")
	}
	return out, nil
}

// DecodeBlob reverses EncodeBlob. The error text does not include the blob.
func DecodeBlob(raw string) (provider, keyID string, ciphertext []byte, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > maxBlobRunes {
		return "", "", nil, fmt.Errorf("wrapped KEK is invalid")
	}
	parts := strings.Split(raw, ":")
	if len(parts) != 4 || parts[0] != blobPrefix || !knownProvider(parts[1]) {
		return "", "", nil, fmt.Errorf("wrapped KEK is invalid")
	}
	id, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !validKeyID(string(id)) {
		return "", "", nil, fmt.Errorf("wrapped KEK is invalid")
	}
	ct, err := base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(ct) == 0 || len(ct) > maxCipher {
		return "", "", nil, fmt.Errorf("wrapped KEK is invalid")
	}
	return parts[1], string(id), ct, nil
}

// WrapBlob wraps a 32-byte KEK and returns the at-rest blob.
func WrapBlob(ctx context.Context, p Provider, kek []byte) (string, error) {
	if p == nil {
		return "", fmt.Errorf("%s is required", EnvProvider)
	}
	if len(kek) != 32 {
		return "", fmt.Errorf("KEK must be 32 bytes")
	}
	ct, err := p.Wrap(ctx, kek)
	if err != nil {
		return "", err
	}
	if len(ct) == 0 {
		return "", ErrUnavailable
	}
	return EncodeBlob(p.Name(), p.KeyID(), ct)
}

// UnwrapBlob recovers a 32-byte KEK. The returned slice is the only copy
// the caller should keep; this function does not log it.
func UnwrapBlob(ctx context.Context, p Provider, blob string) ([]byte, error) {
	if p == nil {
		return nil, fmt.Errorf("%s is required", EnvProvider)
	}
	provider, keyID, ct, err := DecodeBlob(blob)
	if err != nil {
		return nil, err
	}
	if provider != p.Name() {
		return nil, fmt.Errorf("wrapped KEK provider does not match %s", EnvProvider)
	}
	kek, err := p.Unwrap(ctx, keyID, ct)
	if err != nil {
		Wipe(kek)
		return nil, err
	}
	if len(kek) != 32 {
		Wipe(kek)
		return nil, fmt.Errorf("unwrapped KEK must be 32 bytes")
	}
	return kek, nil
}

func validKeyID(id string) bool {
	if id == "" || len(id) > maxKeyID {
		return false
	}
	for _, r := range id {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}
