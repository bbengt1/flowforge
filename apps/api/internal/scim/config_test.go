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

func TestLoadIssuerOnlyEnablesWorkspaceTokens(t *testing.T) {
	t.Setenv(EnvBearerToken, "")
	t.Setenv(EnvIssuer, "https://idp.example/")
	t.Setenv(EnvDefaultRole, "")
	got, err := Load(true, "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Ready() || !got.WorkspaceReady() || got.Issuer != "https://idp.example" || got.DefaultRole != DefaultRole {
		t.Fatalf("issuer-only settings: %+v", got)
	}
	if got.Match("") || got.Match("anything-at-all-that-is-long-enough") {
		t.Fatal("issuer-only config must not accept an instance bearer")
	}

	// OIDC alone does not turn SCIM on; some SCIM_* variable must be set.
	t.Setenv(EnvIssuer, "")
	got, err = Load(true, "https://idp.example")
	if err != nil || got.WorkspaceReady() || got.Ready() {
		t.Fatalf("OIDC only = %+v %v", got, err)
	}
	t.Setenv(EnvDefaultRole, "viewer")
	got, err = Load(true, "https://idp.example")
	if err != nil || !got.WorkspaceReady() || got.Issuer != "https://idp.example" {
		t.Fatalf("role + OIDC issuer = %+v %v", got, err)
	}

	// A role with no issuer anywhere is a boot failure.
	if _, err := Load(true, ""); err == nil {
		t.Fatal("role without issuer must fail")
	}

	// The instance bearer cannot look like a workspace token.
	tok, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvBearerToken, tok)
	if _, err := Load(true, "https://idp.example"); err == nil || strings.Contains(err.Error(), tok) {
		t.Fatalf("workspace-shaped instance bearer: %v", err)
	}
}

func TestLoadGroupsMode(t *testing.T) {
	t.Setenv(EnvBearerToken, "")
	t.Setenv(EnvIssuer, "https://idp.example")
	t.Setenv(EnvDefaultRole, "")
	for _, c := range []struct {
		raw, want string
	}{{"", GroupsModeWorkspaces}, {"workspaces", GroupsModeWorkspaces}, {" groups ", GroupsModeGroups}} {
		t.Setenv(EnvGroupsMode, c.raw)
		got, err := Load(true, "")
		if err != nil || got.Mode() != c.want || got.Groups() != (c.want == GroupsModeGroups) {
			t.Fatalf("%q: %+v %v", c.raw, got.GroupsMode, err)
		}
	}
	// Any other value fails boot, with SCIM on or off.
	for _, bad := range []string{"group", "Groups", "WORKSPACES", "both", "1"} {
		t.Setenv(EnvGroupsMode, bad)
		t.Setenv(EnvIssuer, "https://idp.example")
		if _, err := Load(true, ""); err == nil || !strings.Contains(err.Error(), EnvGroupsMode) {
			t.Fatalf("%q with SCIM on: %v", bad, err)
		}
		t.Setenv(EnvIssuer, "")
		if _, err := Load(true, ""); err == nil {
			t.Fatalf("%q with SCIM off must fail", bad)
		}
	}
	// The zero value is workspaces mode.
	if (Settings{}).Groups() || (Settings{}).Mode() != GroupsModeWorkspaces {
		t.Fatal("zero Settings must be workspaces mode")
	}
}
