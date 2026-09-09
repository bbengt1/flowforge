package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// SignedPayload is the versioned bytes HMAC'd before any JSON parse.
func SignedPayload(version, timestamp string, rawBody []byte) []byte {
	var b strings.Builder
	b.Grow(len(version) + 1 + len(timestamp) + 1 + len(rawBody))
	b.WriteString(version)
	b.WriteByte('.')
	b.WriteString(timestamp)
	b.WriteByte('.')
	b.Write(rawBody)
	return []byte(b.String())
}

// ReplayID is a durable identifier for timestamp+body, retained for the skew window.
func ReplayID(timestamp string, rawBody []byte) string {
	sum := sha256.Sum256(SignedPayload(SignatureVersion, timestamp, rawBody))
	return hex.EncodeToString(sum[:])
}

// ParseSignature accepts `v1=<hex>` (optionally comma-separated versions).
func ParseSignature(header string) (version, hexMAC string, err error) {
	header = strings.TrimSpace(header)
	if header == "" {
		return "", "", ErrBadSignature
	}
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		ver, rest, ok := strings.Cut(part, "=")
		if !ok {
			return "", "", ErrBadSignature
		}
		ver = strings.TrimSpace(ver)
		rest = strings.TrimSpace(rest)
		if ver == SignatureVersion {
			if !isHexMAC(rest) {
				return "", "", ErrBadSignature
			}
			return ver, rest, nil
		}
	}
	return "", "", ErrBadSignature
}

func isHexMAC(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !unicode.Is(unicode.Hex_Digit, r) {
			return false
		}
	}
	return true
}

// VerifySignature checks a versioned HMAC over the exact raw body and timestamp.
func VerifySignature(secret []byte, timestamp string, rawBody []byte, header string) error {
	if len(secret) == 0 {
		return ErrBadSignature
	}
	version, got, err := ParseSignature(header)
	if err != nil {
		return err
	}
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(SignedPayload(version, timestamp, rawBody))
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(strings.ToLower(got))) && !hmac.Equal([]byte(want), []byte(got)) {
		return ErrBadSignature
	}
	return nil
}

// SignV1 is the sender-side helper used by tests and operator docs.
func SignV1(secret []byte, timestamp string, rawBody []byte) string {
	mac := hmac.New(sha256.New, secret)
	_, _ = mac.Write(SignedPayload(SignatureVersion, timestamp, rawBody))
	return SignatureVersion + "=" + hex.EncodeToString(mac.Sum(nil))
}

// CheckTimestamp rejects missing, unparsable, or skewed unix-second timestamps.
func CheckTimestamp(raw string, now time.Time, skew time.Duration) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, ErrTimestampSkew
	}
	sec, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || sec <= 0 {
		return time.Time{}, ErrTimestampSkew
	}
	ts := time.Unix(sec, 0).UTC()
	if skew <= 0 {
		skew = time.Duration(DefaultClockSkewSeconds) * time.Second
	}
	delta := now.UTC().Sub(ts)
	if delta < 0 {
		delta = -delta
	}
	if delta > skew {
		return time.Time{}, ErrTimestampSkew
	}
	return ts, nil
}

// SecretFromCanonical extracts the webhook_secret value from vault plaintext JSON.
func SecretFromCanonical(plaintext []byte) (string, error) {
	if len(plaintext) == 0 {
		return "", ErrBadSignature
	}
	var obj map[string]string
	if err := json.Unmarshal(plaintext, &obj); err != nil {
		return "", ErrBadSignature
	}
	secret := strings.TrimSpace(obj["secret"])
	if secret == "" {
		return "", ErrBadSignature
	}
	return secret, nil
}

// DerivedIdempotencyKey is used when the sender omits Idempotency-Key.
func DerivedIdempotencyKey(publicID, timestamp string, rawBody []byte) string {
	sum := sha256.Sum256([]byte(publicID + "." + timestamp + "." + string(rawBody)))
	return "w" + hex.EncodeToString(sum[:])[:32]
}
