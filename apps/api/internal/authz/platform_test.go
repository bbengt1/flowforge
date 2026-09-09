package authz

import "testing"

func TestParsePlatformAdminsFailClosed(t *testing.T) {
	if got := ParsePlatformAdmins("", ""); len(got) != 0 {
		t.Fatalf("empty must be fail-closed: %v", got)
	}
	if got := ParsePlatformAdmins("not-a-pair, https://idp.example", "missing-pipe"); len(got) != 0 {
		t.Fatalf("invalid entries must be ignored: %v", got)
	}
}

func TestParsePlatformAdminsDedupes(t *testing.T) {
	got := ParsePlatformAdmins(
		"https://idp.example|ops-1, https://idp.example|ops-1, https://idp.example|ops-2",
		"https://idp.example|ops-2",
	)
	if len(got) != 2 {
		t.Fatalf("got %v", got)
	}
	if got[0].Subject != "ops-1" || got[1].Subject != "ops-2" {
		t.Fatalf("got %v", got)
	}
}

func TestIsPlatformAdmin(t *testing.T) {
	allow := []PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	if IsPlatformAdmin("https://idp.example", "ops-1", allow) != true {
		t.Fatal("listed principal must be platform-admin")
	}
	if IsPlatformAdmin("https://idp.example", "admin-1", allow) {
		t.Fatal("workspace admin must not be platform-admin")
	}
	if IsPlatformAdmin("https://idp.example", "ops-1", nil) {
		t.Fatal("empty allowlist must deny")
	}
	if IsPlatformAdmin("", "ops-1", allow) || IsPlatformAdmin("https://idp.example", "", allow) {
		t.Fatal("empty issuer/subject must deny")
	}
}
