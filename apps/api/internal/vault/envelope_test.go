package vault

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"
)

func TestEnvelopeRoundTripAndTamper(t *testing.T) {
	keys := TestKeys()
	plain := []byte(`{"token":"super-secret-plaintext-xyz"}`)
	env, err := Encrypt(keys, plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(env.Ciphertext, plain) || bytes.Contains(env.DEKEnvelope, plain) {
		t.Fatal("plaintext leaked into envelope")
	}
	got, err := Decrypt(keys, env)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("got %s", got)
	}
	env.Ciphertext[len(env.Ciphertext)-1] ^= 0xff
	if _, err := Decrypt(keys, env); err != ErrDecrypt {
		t.Fatalf("tamper = %v", err)
	}
}

func TestEncryptFailsClosedWithoutKEK(t *testing.T) {
	if _, err := Encrypt(Keys{}, []byte("x")); err != ErrKeyUnavailable {
		t.Fatalf("empty keys = %v", err)
	}
}

func TestLoadKeysFromEnvAndFile(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i + 3)
	}
	t.Setenv(EnvKEK, base64.StdEncoding.EncodeToString(raw))
	t.Setenv(EnvKEKID, "")
	t.Setenv(EnvKEKFile, "")
	keys, err := LoadKeys()
	if err != nil || !keys.Ready() || keys.ID != "env:CREDENTIAL_KEK" {
		t.Fatalf("env keys = %+v err=%v", keys, err)
	}

	t.Setenv(EnvKEK, "not-a-key")
	if _, err := LoadKeys(); err == nil {
		t.Fatal("invalid KEK must fail closed")
	}

	dir := t.TempDir()
	path := filepath.Join(dir, "kek")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvKEK, "")
	t.Setenv(EnvKEKFile, path)
	t.Setenv(EnvKEKID, "")
	keys, err = LoadKeys()
	if err != nil || !keys.Ready() || keys.ID != "file:CREDENTIAL_KEK_FILE" {
		t.Fatalf("file keys = %+v err=%v", keys, err)
	}
}

func TestCanonicalSecretRejectsEmpty(t *testing.T) {
	if _, _, err := canonicalizeSecret(TypeToken, map[string]string{"token": "short"}); err == nil {
		t.Fatal("short token")
	}
	plain, fp, err := canonicalizeSecret(TypeToken, map[string]string{"token": "long-enough-token"})
	if err != nil || fp == "" || !bytes.Contains(plain, []byte("long-enough-token")) {
		t.Fatalf("canon = %s %s %v", plain, fp, err)
	}
}

func TestTestPayloadNeverEchoesSecret(t *testing.T) {
	secret := "super-secret-plaintext-xyz"
	status, reason := TestPayload(TypeToken, []byte(`{"token":"`+secret+`"}`))
	if status != TestPassed {
		t.Fatalf("status=%s reason=%s", status, reason)
	}
	if bytes.Contains([]byte(reason), []byte(secret)) {
		t.Fatal("reason leaked plaintext")
	}
	status, reason = TestPayload(TypeKubernetes, []byte(`{"kubeconfig":"`+secret+`"}`))
	if status != TestFailed {
		t.Fatal("invalid kubeconfig should fail")
	}
	if bytes.Contains([]byte(reason), []byte(secret)) {
		t.Fatal("failure reason leaked plaintext")
	}
}

func TestSanitizeMetadataRejectsSecretKeys(t *testing.T) {
	if _, err := sanitizeMetadata(map[string]string{"kubeconfig": "nope"}); err == nil {
		t.Fatal("secret metadata key")
	}
	got, err := sanitizeMetadata(map[string]string{"contextName": "prod"})
	if err != nil || got["contextName"] != "prod" {
		t.Fatalf("got %+v err=%v", got, err)
	}
}
