package itemcursor

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

var bind = Binding{ExecutionID: "11111111-1111-4111-8111-111111111111", StepID: "22222222-2222-4222-8222-222222222222", Port: "main"}

func testKey(b byte) []byte { return []byte(strings.Repeat(string(rune('a'+b)), 32)) }

func TestRoundTripAndBinding(t *testing.T) {
	kr, err := New(testKey(0), nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	tok, err := kr.Sign(bind, 41, now)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := kr.Verify(tok, bind, now); err != nil || got != 41 {
		t.Fatalf("verify = %d %v", got, err)
	}
	for name, b := range map[string]Binding{
		"other run":  {ExecutionID: "33333333-3333-4333-8333-333333333333", StepID: bind.StepID, Port: bind.Port},
		"other step": {ExecutionID: bind.ExecutionID, StepID: "33333333-3333-4333-8333-333333333333", Port: bind.Port},
		"other port": {ExecutionID: bind.ExecutionID, StepID: bind.StepID, Port: "error"},
	} {
		if _, err := kr.Verify(tok, b, now); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s: %v", name, err)
		}
	}
}

func TestForgeryExpiryAndKid(t *testing.T) {
	kr, _ := New(testKey(0), nil)
	now := time.Now()
	tok, _ := kr.Sign(bind, 5, now)
	enc, sig, _ := strings.Cut(tok, ".")
	body, _ := base64.RawURLEncoding.DecodeString(enc)
	var p map[string]any
	_ = json.Unmarshal(body, &p)
	p["a"] = 900
	forged, _ := json.Marshal(p)
	cases := map[string]string{
		"payload edit":   base64.RawURLEncoding.EncodeToString(forged) + "." + sig,
		"sig flip":       enc + "." + flip(sig),
		"no dot":         enc,
		"garbage":        "!!!.???",
		"empty sig":      enc + ".",
		"oversize token": strings.Repeat("a", maxTokenLen+1),
	}
	for name, c := range cases {
		if _, err := kr.Verify(c, bind, now); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%s accepted: %v", name, err)
		}
	}
	if _, err := kr.Verify(tok, bind, now.Add(TTL)); !errors.Is(err, ErrInvalid) {
		t.Fatalf("expired accepted: %v", err)
	}
	if _, err := kr.Verify(tok, bind, now.Add(TTL-time.Second)); err != nil {
		t.Fatalf("fresh refused: %v", err)
	}
	other, _ := New(testKey(1), nil)
	if _, err := other.Verify(tok, bind, now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown kid accepted: %v", err)
	}
}

func TestRotationAcceptsPreviousKid(t *testing.T) {
	old, _ := New(testKey(0), nil)
	now := time.Now()
	tok, _ := old.Sign(bind, 3, now)
	rotated, err := New(testKey(1), testKey(0))
	if err != nil {
		t.Fatal(err)
	}
	if rotated.KID() == old.KID() {
		t.Fatal("kid did not change")
	}
	if got, err := rotated.Verify(tok, bind, now); err != nil || got != 3 {
		t.Fatalf("previous kid refused: %d %v", got, err)
	}
	if _, err := rotated.Verify(tok, bind, now.Add(TTL)); !errors.Is(err, ErrInvalid) {
		t.Fatal("previous-kid cursor outlived its expiry")
	}
	dropped, _ := New(testKey(1), nil)
	if _, err := dropped.Verify(tok, bind, now); !errors.Is(err, ErrInvalid) {
		t.Fatal("dropped previous kid still accepted")
	}
}

func TestNoWorkspaceIDInCursor(t *testing.T) {
	kr := NewRandom()
	tok, _ := kr.Sign(bind, 0, time.Now())
	enc, _, _ := strings.Cut(tok, ".")
	body, _ := base64.RawURLEncoding.DecodeString(enc)
	var p map[string]any
	if err := json.Unmarshal(body, &p); err != nil {
		t.Fatal(err)
	}
	for k := range p {
		switch k {
		case "v", "k", "e", "s", "p", "a", "x":
		default:
			t.Fatalf("unexpected cursor field %q", k)
		}
	}
	if strings.Contains(strings.ToLower(string(body)), "workspace") {
		t.Fatal("cursor mentions workspace")
	}
}

func TestLoadFailsClosed(t *testing.T) {
	for name, v := range map[string]string{
		"missing":      "",
		"short raw":    "too-short",
		"short base64": base64.StdEncoding.EncodeToString([]byte("sixteen-bytes!!!")),
		"short hex":    "00112233445566778899aabbccdd",
		"whitespace":   "   ",
	} {
		t.Setenv(EnvSecret, v)
		t.Setenv(EnvSecretPrevious, "")
		if _, err := Load(); !errors.Is(err, ErrSecret) {
			t.Fatalf("%s: %v", name, err)
		} else if v != "" && strings.TrimSpace(v) != "" && strings.Contains(err.Error(), v) {
			t.Fatalf("%s: error echoes the secret", name)
		}
	}
	t.Setenv(EnvSecret, base64.StdEncoding.EncodeToString(testKey(0)))
	if _, err := Load(); err != nil {
		t.Fatalf("valid base64: %v", err)
	}
	t.Setenv(EnvSecretPrevious, "short")
	if _, err := Load(); !errors.Is(err, ErrSecret) {
		t.Fatalf("short previous: %v", err)
	}
	t.Setenv(EnvSecretPrevious, "")
	t.Setenv(EnvSecret, strings.Repeat("ab", 32))
	if _, err := Load(); err != nil {
		t.Fatalf("valid hex: %v", err)
	}
}

func flip(s string) string {
	b := []byte(s)
	if b[0] == 'A' {
		b[0] = 'B'
	} else {
		b[0] = 'A'
	}
	return string(b)
}
