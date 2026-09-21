package scripts

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
)

func TestLoadSigningKeyFailsClosed(t *testing.T) {
	t.Setenv(EnvScriptSigningKey, "")
	if _, err := LoadSigningKey(); !errors.Is(err, ErrSigningKeyRequired) {
		t.Fatalf("empty: %v", err)
	}

	malformed := "not-a-32-byte-hmac-key"
	t.Setenv(EnvScriptSigningKey, malformed)
	key, err := LoadSigningKey()
	if !errors.Is(err, ErrSigningKeyRequired) {
		t.Fatalf("malformed: %v", err)
	}
	if key != nil {
		t.Fatal("malformed must not return a key")
	}
	if strings.Contains(err.Error(), malformed) {
		t.Fatalf("error must not include the secret value: %v", err)
	}

	raw := []byte("flowforge-test-script-sign-32b!!")
	if len(raw) != 32 {
		t.Fatalf("fixture length %d", len(raw))
	}
	t.Setenv(EnvScriptSigningKey, base64.StdEncoding.EncodeToString(raw))
	got, err := LoadSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) {
		t.Fatalf("std base64 decoded %d bytes", len(got))
	}

	t.Setenv(EnvScriptSigningKey, hex.EncodeToString(raw))
	got, err = LoadSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) {
		t.Fatal("hex must decode to the same key")
	}

	t.Setenv(EnvScriptSigningKey, string(raw))
	got, err = LoadSigningKey()
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(raw) {
		t.Fatal("raw 32-byte value must be accepted")
	}
}
