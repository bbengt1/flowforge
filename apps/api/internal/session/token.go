package session

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
)

const tokenBytes = 32

func newToken() (string, error) {
	var b [tokenBytes]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

// CSRFMatches reports whether token hashes to the session CSRF secret.
func CSRFMatches(record Record, token string) bool {
	return csrfMatches(record, token)
}

func csrfMatches(record Record, token string) bool {
	want := record.CSRFHash()
	if len(want) != tokenBytes || token == "" {
		return false
	}
	got := hashToken(token)
	return subtle.ConstantTimeCompare(want, got) == 1
}

// SecretsEqual compares untrusted tokens in constant time.
func SecretsEqual(a, b string) bool {
	return tokensEqual(a, b)
}

func tokensEqual(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if len(a) != len(b) {
		// Compare hashes so length is not leaked as a short-circuit on the
		// caller-supplied pair; both values are already untrusted.
		return subtle.ConstantTimeCompare(hashToken(a), hashToken(b)) == 1
	}
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}
