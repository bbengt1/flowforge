package mfa

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"io"
)

const secretAAD = "mfa-totp"

// Seal encrypts a TOTP secret. The key must be 32 bytes.
func Seal(key, plaintext []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrNotConfigured
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrNotConfigured
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, ErrUnavailable
	}
	return gcm.Seal(nonce, nonce, plaintext, []byte(secretAAD)), nil
}

// Open decrypts a TOTP secret. A wrong key fails closed.
func Open(key, blob []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrNotConfigured
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrNotConfigured
	}
	ns := gcm.NonceSize()
	if len(blob) < ns+gcm.Overhead() {
		return nil, ErrRejected
	}
	plain, err := gcm.Open(nil, blob[:ns], blob[ns:], []byte(secretAAD))
	if err != nil {
		return nil, ErrNotConfigured
	}
	return plain, nil
}
