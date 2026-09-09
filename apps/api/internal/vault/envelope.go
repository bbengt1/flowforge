package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
)

const (
	EncryptionVersion = 1
	nonceSize         = 12
	dekSize           = 32
)

// Envelope is the persisted ciphertext plus wrapped data-encryption key.
// None of these fields are returned on HTTP APIs.
type Envelope struct {
	Ciphertext  []byte
	DEKEnvelope []byte
	KeyRef      string
	Version     int
}

// Encrypt wraps plaintext with a random DEK, then wraps the DEK with the KEK.
func Encrypt(keys Keys, plaintext []byte) (Envelope, error) {
	if !keys.Ready() {
		return Envelope{}, ErrKeyUnavailable
	}
	if len(plaintext) == 0 {
		return Envelope{}, ErrInvalid
	}
	dek := make([]byte, dekSize)
	if _, err := io.ReadFull(rand.Reader, dek); err != nil {
		return Envelope{}, fmt.Errorf("generate dek: %w", err)
	}
	ct, err := seal(dek, plaintext)
	if err != nil {
		return Envelope{}, err
	}
	wrapped, err := seal(keys.KEK, dek)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{
		Ciphertext:  ct,
		DEKEnvelope: wrapped,
		KeyRef:      keys.ID,
		Version:     EncryptionVersion,
	}, nil
}

// Decrypt recovers plaintext. Callers must not persist or log the result.
func Decrypt(keys Keys, env Envelope) ([]byte, error) {
	if !keys.Ready() {
		return nil, ErrKeyUnavailable
	}
	if env.Version != 0 && env.Version != EncryptionVersion {
		return nil, ErrInvalid
	}
	dek, err := open(keys.KEK, env.DEKEnvelope)
	if err != nil {
		return nil, ErrDecrypt
	}
	plain, err := open(dek, env.Ciphertext)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plain, nil
}

func seal(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceSize)
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	out := gcm.Seal(nonce, nonce, plaintext, nil)
	return out, nil
}

func open(key, blob []byte) ([]byte, error) {
	if len(blob) < nonceSize+gcmTagSize {
		return nil, ErrDecrypt
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrDecrypt
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrDecrypt
	}
	nonce, ct := blob[:nonceSize], blob[nonceSize:]
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, ErrDecrypt
	}
	return plain, nil
}

const gcmTagSize = 16

var (
	ErrKeyUnavailable = errors.New("credential encryption key is not configured")
	ErrDecrypt        = errors.New("credential payload could not be decrypted")
	ErrInvalid        = errors.New("invalid credential")
	ErrNotFound       = errors.New("not found")
	ErrConflict       = errors.New("conflict")
	ErrNoScope        = errors.New("workspace scope is not set")
	ErrDisabled       = errors.New("credential is disabled")
	ErrExpired        = errors.New("credential is expired")
	ErrInUse          = errors.New("credential is referenced by an active execution")
	ErrNotConfirmed   = errors.New("credential deletion was not confirmed")
)
