// Package itemcursor signs and verifies the opaque paging cursor for
// GET /api/v1/executions/{executionId}/steps/{stepId}/items (#650 E3.1).
//
// A cursor binds execution + step + port + last idx and carries a key id
// (kid) and a signed expiry. It never carries a workspace id: the server
// re-checks the step under RLS. The key is ITEMS_CURSOR_SECRET, separate
// from JOB_BINDING_SECRET. ITEMS_CURSOR_SECRET_PREVIOUS, when set, keeps
// cursors signed by the previous key valid during a rotation; drop it once
// those cursors have expired (TTL, 15 minutes).
package itemcursor

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	EnvSecret         = "ITEMS_CURSOR_SECRET"
	EnvSecretPrevious = "ITEMS_CURSOR_SECRET_PREVIOUS"
	// MinKeyBytes is the minimum decoded key length.
	MinKeyBytes = 32
	// TTL is the signed cursor lifetime.
	TTL         = 15 * time.Minute
	version     = 1
	maxTokenLen = 1024
)

var (
	// ErrSecret is a boot-fail: the key is missing or shorter than 32 bytes.
	ErrSecret = errors.New("ITEMS_CURSOR_SECRET is missing or malformed")
	// ErrInvalid is any cursor that fails to parse, verify, bind, or is
	// expired or signed by an unknown kid. The HTTP layer maps it to 400
	// cursor-invalid. It never says which check failed.
	ErrInvalid = errors.New("cursor-invalid")
)

type key struct {
	kid    string
	secret []byte
}

// Keyring holds the current signing key and an optional previous key that
// is still accepted for verification.
type Keyring struct {
	current  key
	previous *key
}

// Binding is what a cursor is bound to.
type Binding struct {
	ExecutionID string
	StepID      string
	Port        string
}

type payload struct {
	V   int    `json:"v"`
	Kid string `json:"k"`
	E   string `json:"e"`
	S   string `json:"s"`
	P   string `json:"p"`
	A   int    `json:"a"`
	X   int64  `json:"x"`
}

// New builds a keyring from raw key bytes. previous may be nil.
func New(current, previous []byte) (*Keyring, error) {
	if len(current) < MinKeyBytes {
		return nil, ErrSecret
	}
	kr := &Keyring{current: newKey(current)}
	if previous != nil {
		if len(previous) < MinKeyBytes {
			return nil, ErrSecret
		}
		p := newKey(previous)
		kr.previous = &p
	}
	return kr, nil
}

// kid is a short one-way fingerprint of the key. It identifies the key
// for rotation and reveals nothing usable about it.
func newKey(secret []byte) key {
	sum := sha256.Sum256(append([]byte("flowforge-items-cursor-kid\x00"), secret...))
	return key{kid: hex.EncodeToString(sum[:4]), secret: append([]byte(nil), secret...)}
}

// Load reads ITEMS_CURSOR_SECRET (and the optional previous key). Missing,
// undecodable, or short values fail closed; the process refuses to start.
// Errors never include the secret.
func Load() (*Keyring, error) {
	cur, err := parse(os.Getenv(EnvSecret), EnvSecret, true)
	if err != nil {
		return nil, err
	}
	prev, err := parse(os.Getenv(EnvSecretPrevious), EnvSecretPrevious, false)
	if err != nil {
		return nil, err
	}
	return New(cur, prev)
}

// parse accepts the same formats as JOB_BINDING_SECRET (standard or URL
// base64, padded or raw, or hex), decoding to at least 32 bytes. Plain
// passphrases are refused.
func parse(raw, name string, required bool) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		if required {
			return nil, fmt.Errorf("%w: set %s (at least 32 bytes as base64 or hex); the process refuses to start without it", ErrSecret, name)
		}
		return nil, nil
	}
	decoders := []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
		base64.URLEncoding.DecodeString,
		base64.RawURLEncoding.DecodeString,
		hex.DecodeString,
	}
	for _, dec := range decoders {
		if b, err := dec(raw); err == nil && len(b) >= MinKeyBytes {
			return b, nil
		}
	}
	// L3: plain passphrases are refused; the value must decode.
	return nil, fmt.Errorf("%w: %s must be base64 or hex decoding to at least 32 bytes", ErrSecret, name)
}

// KID returns the current key id.
func (k *Keyring) KID() string {
	if k == nil {
		return ""
	}
	return k.current.kid
}

// Sign returns an opaque cursor for the page after afterIdx.
func (k *Keyring) Sign(b Binding, afterIdx int, now time.Time) (string, error) {
	if k == nil || afterIdx < 0 {
		return "", ErrInvalid
	}
	p := payload{V: version, Kid: k.current.kid, E: b.ExecutionID, S: b.StepID, P: b.Port, A: afterIdx, X: now.Add(TTL).Unix()}
	body, err := json.Marshal(p)
	if err != nil {
		return "", ErrInvalid
	}
	enc := base64.RawURLEncoding.EncodeToString(body)
	return enc + "." + base64.RawURLEncoding.EncodeToString(mac(k.current.secret, enc)), nil
}

// Verify checks signature, kid, expiry, and binding and returns the last
// idx. Any failure is ErrInvalid.
func (k *Keyring) Verify(token string, b Binding, now time.Time) (int, error) {
	if k == nil || token == "" || len(token) > maxTokenLen {
		return 0, ErrInvalid
	}
	enc, sigEnc, ok := strings.Cut(token, ".")
	if !ok || enc == "" || sigEnc == "" {
		return 0, ErrInvalid
	}
	sig, err := base64.RawURLEncoding.DecodeString(sigEnc)
	if err != nil {
		return 0, ErrInvalid
	}
	body, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil {
		return 0, ErrInvalid
	}
	var p payload
	if err := json.Unmarshal(body, &p); err != nil {
		return 0, ErrInvalid
	}
	var secret []byte
	switch {
	case p.Kid == k.current.kid:
		secret = k.current.secret
	case k.previous != nil && p.Kid == k.previous.kid:
		secret = k.previous.secret
	default:
		return 0, ErrInvalid
	}
	if !hmac.Equal(sig, mac(secret, enc)) {
		return 0, ErrInvalid
	}
	if p.V != version || !now.Before(time.Unix(p.X, 0)) {
		return 0, ErrInvalid
	}
	if p.E != b.ExecutionID || p.S != b.StepID || p.P != b.Port || p.A < 0 {
		return 0, ErrInvalid
	}
	return p.A, nil
}

func mac(secret []byte, msg string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte("flowforge-items-cursor-v1\x00"))
	h.Write([]byte(msg))
	return h.Sum(nil)
}

// NewRandom returns a keyring with a fresh random key for unit tests. It
// is never a production or compose default and Load never uses it.
func NewRandom() *Keyring {
	b := make([]byte, MinKeyBytes)
	if _, err := rand.Read(b); err != nil {
		panic("generate test items cursor key: " + err.Error())
	}
	k, _ := New(b, nil)
	return k
}
