package scim

import (
	"strings"
	"testing"
)

func TestLoadFailClosed(t *testing.T) {
	const token = "scim-bearer-token-value-that-must-not-leak"
	t.Setenv(EnvBearerToken, "")
	t.Setenv(EnvIssuer, "")
	t.Setenv(EnvDefaultRole, "")
	got, err := Load(true, "")
	if err != nil || got.Ready() {
		t.Fatalf("empty config = %+v %v", got, err)
	}

	t.Setenv(EnvBearerToken, token)
	if _, err := Load(true, ""); err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("token without issuer: %v", err)
	}
	t.Setenv(EnvIssuer, "https://idp.example")
	t.Setenv(EnvBearerToken, "short-token")
	if _, err := Load(false, ""); err == nil || strings.Contains(err.Error(), "short-token") {
		t.Fatalf("short token: %v", err)
	}
	t.Setenv(EnvBearerToken, token)
	t.Setenv(EnvIssuer, "http://idp.example")
	if _, err := Load(true, ""); err == nil {
		t.Fatal("production http issuer must fail")
	}
	t.Setenv(EnvIssuer, "https://other.example")
	if _, err := Load(true, "https://idp.example"); err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("issuer mismatch: %v", err)
	}
	t.Setenv(EnvDefaultRole, "platform-admin")
	t.Setenv(EnvIssuer, "https://idp.example")
	if _, err := Load(true, "https://idp.example"); err == nil {
		t.Fatal("platform-admin role must fail")
	}
}

func TestLoadMatchesOIDCIssuer(t *testing.T) {
	const token = "scim-bearer-token-value-that-must-not-leak"
	t.Setenv(EnvBearerToken, token)
	t.Setenv(EnvIssuer, "")
	t.Setenv(EnvDefaultRole, "")
	got, err := Load(true, "https://idp.example")
	if err != nil {
		t.Fatal(err)
	}
	if got.Issuer != "https://idp.example" || got.DefaultRole != DefaultRole {
		t.Fatalf("settings: %+v", got)
	}
	if !got.Match(token) || got.Match(token+"x") || got.Match("") {
		t.Fatal("bearer match failed")
	}
}
