package embed

import (
	"errors"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestHTTPSIssuer(t *testing.T) {
	if !HTTPSIssuer("https://idp.example") || !HTTPSIssuer("HTTPS://idp.example/realms/ff") {
		t.Fatal("https with host must be accepted")
	}
	for _, iss := range []string{
		"",
		"http://idp.example",
		"idp.example",
		"/relative",
		"//idp.example",
		"urn:example:idp",
		"https:",
		"https://",
		"https://user:pass@idp.example",
		"ftp://idp.example",
	} {
		if HTTPSIssuer(iss) {
			t.Fatalf("must reject %q", iss)
		}
	}
}

func TestValidateIssuerAllowlistProduction(t *testing.T) {
	if err := ValidateIssuerAllowlist(nil, true); err != nil {
		t.Fatalf("empty allowlist must stay request-time fail-closed: %v", err)
	}
	if err := ValidateIssuerAllowlist([]string{}, true); err != nil {
		t.Fatalf("empty slice must stay request-time fail-closed: %v", err)
	}
	if err := ValidateIssuerAllowlist([]string{"https://idp.example", "https://host-b.example"}, true); err != nil {
		t.Fatalf("https allowlist: %v", err)
	}
	for _, iss := range []string{"http://idp.example", "idp.example", "urn:example:idp", "//idp.example"} {
		err := ValidateIssuerAllowlist([]string{iss}, true)
		if !errors.Is(err, ErrIssuerNotHTTPS) {
			t.Fatalf("%q: %v", iss, err)
		}
	}
	if err := ValidateIssuerAllowlist([]string{"http://idp.example"}, false); err != nil {
		t.Fatalf("non-prod http must be allowed: %v", err)
	}
}

func TestIssuerAllowedHTTPSInProduction(t *testing.T) {
	t.Setenv(authz.EnvAppEnv, "production")
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv(authz.EnvRequireTLS, "")

	httpsAllow := []string{"https://idp.example"}
	if !IssuerAllowed("https://idp.example", httpsAllow) {
		t.Fatal("https issuer must be accepted in production")
	}
	if IssuerAllowed("https://hostile.example", httpsAllow) {
		t.Fatal("unknown https issuer must stay denied")
	}
	if IssuerAllowed("https://idp.example", nil) || IssuerAllowed("https://idp.example", []string{}) {
		t.Fatal("empty allowlist must fail closed (ADV-005)")
	}

	httpAllow := []string{"http://idp.example"}
	if IssuerAllowed("http://idp.example", httpAllow) {
		t.Fatal("http issuer must be rejected in production even when listed")
	}
	if IssuerAllowed("idp.example", []string{"idp.example"}) {
		t.Fatal("relative issuer must be rejected in production")
	}
	if IssuerAllowed("urn:example:idp", []string{"urn:example:idp"}) {
		t.Fatal("opaque issuer must be rejected in production")
	}
}

func TestIssuerAllowedHTTPInNonProduction(t *testing.T) {
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv(authz.EnvRequireTLS, "")
	httpAllow := []string{"http://idp.example"}
	for _, env := range []string{"development", "dev", "local", "test"} {
		t.Setenv(authz.EnvAppEnv, env)
		if !IssuerAllowed("http://idp.example", httpAllow) {
			t.Fatalf("%s: http issuer must be allowed when listed", env)
		}
		if IssuerAllowed("http://hostile.example", httpAllow) {
			t.Fatalf("%s: unknown http issuer must stay denied", env)
		}
		if IssuerAllowed("http://idp.example", nil) {
			t.Fatalf("%s: empty allowlist must fail closed", env)
		}
	}

	t.Setenv(authz.EnvAppEnv, "development")
	t.Setenv(authz.EnvRequireTLS, "true")
	if IssuerAllowed("http://idp.example", httpAllow) {
		t.Fatal("REQUIRE_TLS must reject http issuers even in development")
	}
	if !IssuerAllowed("https://idp.example", []string{"https://idp.example"}) {
		t.Fatal("REQUIRE_TLS must still accept https")
	}
}

func TestVerifyRejectsHTTPIssuerInProduction(t *testing.T) {
	t.Setenv(authz.EnvAppEnv, "")
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv(authz.EnvRequireTLS, "")

	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	in := testMintInput(now)
	in.Issuer = "http://idp.example"
	in.Host = "http://idp.example"
	minted, _, err := Mint(m, in)
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: in.WorkspaceID,
		AllowedIssuers: []string{"http://idp.example"},
	}
	if _, err := Verify(m, minted.Assertion, opt); err != ErrIssuerNotAllowed {
		t.Fatalf("production http issuer: %v", err)
	}
}

func TestVerifyAcceptsHTTPIssuerInNonProduction(t *testing.T) {
	t.Setenv(authz.EnvAppEnv, "development")
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv(authz.EnvRequireTLS, "")

	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	in := testMintInput(now)
	in.Issuer = "http://idp.example"
	in.Host = "http://idp.example"
	minted, _, err := Mint(m, in)
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: in.WorkspaceID,
		AllowedIssuers: []string{"http://idp.example"},
	}
	if _, err := Verify(m, minted.Assertion, opt); err != nil {
		t.Fatalf("non-prod http issuer: %v", err)
	}
}
