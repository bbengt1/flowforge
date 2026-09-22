package mfa

import (
	"strings"
	"testing"
	"time"
)

func TestTOTPRFC6238SHA1(t *testing.T) {
	secret := []byte("12345678901234567890")
	// RFC 6238 appendix B, SHA1, 8 digits truncated to the 6-digit dynamic value
	// is not what we implement. The 6-digit SHA1 vector at T=59 is 287082.
	if got := Code(secret, 59/30); got != "287082" {
		t.Fatalf("T=59 code = %s", got)
	}
	if got := Code(secret, 1111111109/30); got != "081804" {
		t.Fatalf("T=1111111109 code = %s", got)
	}
}

func TestMatchRejectsReplayAndWrongCode(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 22, 12, 0, 0, 0, time.UTC)
	code := Code(secret, Step(now))
	step, err := Match(secret, code, now, 0)
	if err != nil || step != Step(now) {
		t.Fatalf("match: step=%d err=%v", step, err)
	}
	if _, err := Match(secret, code, now, step); err == nil {
		t.Fatal("replay must fail")
	}
	if _, err := Match(secret, "000000", now, 0); err == nil {
		t.Fatal("wrong code must fail")
	}
	uri := ProvisioningURI(secret, "admin@example.com")
	if !strings.Contains(uri, "otpauth://totp/") || strings.Contains(uri, "client_secret") {
		t.Fatalf("uri %s", uri)
	}
}

func TestLoadKeyEmptyAndMalformed(t *testing.T) {
	t.Setenv(EnvSecretKey, "")
	key, err := LoadKey()
	if err != nil || key != nil {
		t.Fatalf("empty key=%v err=%v", key, err)
	}
	t.Setenv(EnvSecretKey, "not-a-key")
	if _, err := LoadKey(); err == nil {
		t.Fatal("malformed key must fail")
	}
	if strings.Contains(errString(t), "not-a-key") {
		t.Fatal("error must not echo the key")
	}
}

func errString(t *testing.T) string {
	t.Helper()
	_, err := LoadKey()
	if err == nil {
		t.Fatal("expected error")
	}
	return err.Error()
}
