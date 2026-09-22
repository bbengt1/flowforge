package oidc

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"io"
)

func seal(key, plaintext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return gcm.Seal(nonce, nonce, plaintext, aad), nil
}

func open(key, blob, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, ErrRejected
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, ErrRejected
	}
	ns := gcm.NonceSize()
	if len(blob) < ns+gcm.Overhead() {
		return nil, ErrRejected
	}
	plain, err := gcm.Open(nil, blob[:ns], blob[ns:], aad)
	if err != nil {
		return nil, ErrRejected
	}
	return plain, nil
}
