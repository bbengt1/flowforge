package embed

import (
	"testing"
	"time"
)

func TestNormalizeNBFLeeway(t *testing.T) {
	if got := NormalizeNBFLeeway(0); got != DefaultNBFLeeway {
		t.Fatalf("zero: %s", got)
	}
	if got := NormalizeNBFLeeway(-time.Second); got != DefaultNBFLeeway {
		t.Fatalf("negative: %s", got)
	}
	if got := NormalizeNBFLeeway(15 * time.Second); got != 15*time.Second {
		t.Fatalf("custom: %s", got)
	}
	if got := NormalizeNBFLeeway(MaxNBFLeeway); got != MaxNBFLeeway {
		t.Fatalf("max: %s", got)
	}
	if got := NormalizeNBFLeeway(5 * time.Minute); got != MaxNBFLeeway {
		t.Fatalf("above max must clamp, got %s", got)
	}
}

func TestLoadNBFLeeway(t *testing.T) {
	t.Setenv(EnvNBFLeeway, "")
	if got := LoadNBFLeeway(); got != DefaultNBFLeeway {
		t.Fatalf("empty: %s", got)
	}
	t.Setenv(EnvNBFLeeway, "15s")
	if got := LoadNBFLeeway(); got != 15*time.Second {
		t.Fatalf("15s: %s", got)
	}
	t.Setenv(EnvNBFLeeway, "5m")
	if got := LoadNBFLeeway(); got != MaxNBFLeeway {
		t.Fatalf("5m must clamp to %s, got %s", MaxNBFLeeway, got)
	}
	t.Setenv(EnvNBFLeeway, "nope")
	if got := LoadNBFLeeway(); got != DefaultNBFLeeway {
		t.Fatalf("invalid: %s", got)
	}
}

func TestVerifyNBFLeewayAcceptsBarelyFuture(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	c := Claims{
		Issuer:       "https://portal.example",
		Audience:     DefaultAudience,
		Subject:      "operator-1",
		NotBefore:    now.Add(DefaultNBFLeeway).Unix(),
		ExpiresAt:    now.Add(2 * time.Minute).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          SDKVersion,
	}
	token := mustSignRaw(t, m, c)
	opt := VerifyOptions{Now: now, SkipJTI: true, AllowedIssuers: []string{c.Issuer}}
	if _, err := Verify(m, token, opt); err != nil {
		t.Fatalf("nbf at default leeway bound must accept: %v", err)
	}
	c.NotBefore = now.Add(DefaultNBFLeeway + time.Second).Unix()
	token = mustSignRaw(t, m, c)
	if _, err := Verify(m, token, opt); err != ErrNotYetValid {
		t.Fatalf("nbf beyond default leeway must reject: %v", err)
	}
}

func TestVerifyNBFLeewayCustomAndCap(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	c := Claims{
		Issuer:       "https://portal.example",
		Audience:     DefaultAudience,
		Subject:      "operator-1",
		NotBefore:    now.Add(15 * time.Second).Unix(),
		ExpiresAt:    now.Add(2 * time.Minute).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          SDKVersion,
	}
	token := mustSignRaw(t, m, c)
	if _, err := Verify(m, token, VerifyOptions{
		Now: now, SkipJTI: true, AllowedIssuers: []string{c.Issuer}, NBFLeeway: 15 * time.Second,
	}); err != nil {
		t.Fatalf("within custom leeway: %v", err)
	}
	if _, err := Verify(m, token, VerifyOptions{
		Now: now, SkipJTI: true, AllowedIssuers: []string{c.Issuer}, NBFLeeway: 10 * time.Second,
	}); err != ErrNotYetValid {
		t.Fatalf("beyond custom leeway: %v", err)
	}

	c.NotBefore = now.Add(MaxNBFLeeway + time.Second).Unix()
	token = mustSignRaw(t, m, c)
	if _, err := Verify(m, token, VerifyOptions{
		Now: now, SkipJTI: true, AllowedIssuers: []string{c.Issuer}, NBFLeeway: 5 * time.Minute,
	}); err != ErrNotYetValid {
		t.Fatalf("leeway above max must still reject nbf past 60s: %v", err)
	}
	c.NotBefore = now.Add(MaxNBFLeeway).Unix()
	token = mustSignRaw(t, m, c)
	if _, err := Verify(m, token, VerifyOptions{
		Now: now, SkipJTI: true, AllowedIssuers: []string{c.Issuer}, NBFLeeway: 5 * time.Minute,
	}); err != nil {
		t.Fatalf("clamped max leeway must accept nbf at 60s: %v", err)
	}
}

func TestVerifyExpHasNoLeeway(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	c := Claims{
		Issuer:       "https://portal.example",
		Audience:     DefaultAudience,
		Subject:      "operator-1",
		NotBefore:    now.Add(-time.Minute).Unix(),
		ExpiresAt:    now.Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          SDKVersion,
	}
	token := mustSignRaw(t, m, c)
	if _, err := Verify(m, token, VerifyOptions{
		Now: now, SkipJTI: true, AllowedIssuers: []string{c.Issuer}, NBFLeeway: MaxNBFLeeway,
	}); err != ErrExpired {
		t.Fatalf("exp must stay exact even when nbf leeway is set: %v", err)
	}
}
