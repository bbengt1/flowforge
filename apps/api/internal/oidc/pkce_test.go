package oidc

import (
	"strings"
	"testing"
)

func TestS256ChallengeIsNotTheVerifier(t *testing.T) {
	verifier, err := newVerifier()
	if err != nil {
		t.Fatal(err)
	}
	challenge := S256Challenge(verifier)
	if challenge == verifier || strings.Contains(challenge, verifier) {
		t.Fatal("challenge must not echo the verifier")
	}
	if len(challenge) < 43 || strings.Contains(challenge, "=") {
		t.Fatalf("challenge %q", challenge)
	}
	if S256Challenge(verifier) != challenge {
		t.Fatal("challenge must be stable")
	}
}

func TestLoadEmptyIsOff(t *testing.T) {
	t.Setenv(EnvIssuer, "")
	t.Setenv(EnvClientID, "")
	t.Setenv(EnvClientSecret, "")
	t.Setenv(EnvRedirectURI, "")
	t.Setenv(EnvStateKey, "")
	t.Setenv(EnvScopes, "")
	got, err := Load(true)
	if err != nil {
		t.Fatal(err)
	}
	if got.Ready() {
		t.Fatal("empty config must not be ready")
	}
}

func TestLoadPartialFailsClosedWithoutEchoingSecret(t *testing.T) {
	const secret = "super-secret-oidc-value"
	t.Setenv(EnvIssuer, "https://idp.example")
	t.Setenv(EnvClientID, "flowforge")
	t.Setenv(EnvClientSecret, secret)
	t.Setenv(EnvRedirectURI, "")
	t.Setenv(EnvStateKey, "")
	t.Setenv(EnvScopes, "")
	_, err := Load(true)
	if err == nil {
		t.Fatal("partial config must fail")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("config error echoed the client secret")
	}
}

func TestLoadRejectsHTTPIssuerInProduction(t *testing.T) {
	t.Setenv(EnvIssuer, "http://idp.example")
	t.Setenv(EnvClientID, "flowforge")
	t.Setenv(EnvClientSecret, "super-secret-oidc-value")
	t.Setenv(EnvRedirectURI, "https://app.example/callback")
	t.Setenv(EnvStateKey, strings.Repeat("ab", 32))
	t.Setenv(EnvScopes, "")
	if _, err := Load(true); err == nil {
		t.Fatal("production http issuer must fail")
	}
}

func TestLoadAcceptsCompleteConfig(t *testing.T) {
	t.Setenv(EnvIssuer, "https://idp.example/")
	t.Setenv(EnvClientID, "flowforge")
	t.Setenv(EnvClientSecret, "super-secret-oidc-value")
	t.Setenv(EnvRedirectURI, "https://app.example/callback")
	t.Setenv(EnvStateKey, strings.Repeat("ab", 32))
	t.Setenv(EnvScopes, "openid email")
	got, err := Load(true)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Ready() || got.Issuer != "https://idp.example" || got.ClientSecret == "" {
		t.Fatalf("ready=%v issuer=%s", got.Ready(), got.Issuer)
	}
	if strings.Contains(got.Issuer, got.ClientSecret) {
		t.Fatal("issuer must not contain the secret")
	}
}
