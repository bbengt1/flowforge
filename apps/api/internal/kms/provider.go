package kms

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

const (
	// Purpose is bound into each wrap so a ciphertext from another
	// workload cannot be unwrapped as a FlowForge KEK.
	Purpose = "flowforge-credential-kek"

	// EnvProvider selects aws, gcp, azure, or vault. Empty keeps the
	// local plaintext KEK path, which a production-locked process rejects
	// once any vault key material is configured.
	EnvProvider = "KMS_PROVIDER"
	// EnvKeyID is the shared CMK / transit key id used when a
	// provider-specific key variable is unset.
	EnvKeyID = "KMS_KEY_ID"
)

// ErrUnavailable is the only error returned for a failed KMS call.
// Provider errors can echo request bodies, so they are not wrapped.
var ErrUnavailable = errors.New("key management request failed")

// Provider wraps and unwraps the 32-byte data-encryption KEK.
// Implementations must not log plaintext or wrapped key material.
type Provider interface {
	// Name is aws, gcp, azure, or vault.
	Name() string
	// KeyID is the active CMK or transit key used for Wrap.
	// It is an identifier, not secret key material.
	KeyID() string
	Wrap(ctx context.Context, kek []byte) ([]byte, error)
	// Unwrap keyID is the id stored with the wrapped blob. It may differ
	// from KeyID during a CMK overlap. Empty uses the active key.
	Unwrap(ctx context.Context, keyID string, wrapped []byte) ([]byte, error)
}

// Wipe zeros key material. Callers still drop their own copies.
func Wipe(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

// NewKeyReference is a fresh credentials.key_reference for a data-KEK
// rotation. It is not derived from key bytes.
func NewKeyReference(provider string) (string, error) {
	if !knownProvider(provider) {
		return "", fmt.Errorf("%s is not a KMS provider", EnvProvider)
	}
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generate key reference: %w", err)
	}
	return "kms:" + provider + ":" + hex.EncodeToString(buf[:]), nil
}

// DefaultKeyReference is stable for a provider and CMK id so a restart
// does not rename the active key. Data-KEK rotation must set a new
// CREDENTIAL_KEK_ID instead of relying on this default.
func DefaultKeyReference(provider, keyID string) string {
	sum := sha256.Sum256([]byte(provider + "\n" + keyID))
	return "kms:" + provider + ":" + hex.EncodeToString(sum[:8])
}

func knownProvider(name string) bool {
	switch name {
	case "aws", "gcp", "azure", "vault":
		return true
	default:
		return false
	}
}
