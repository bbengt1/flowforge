package authz

import "testing"

func TestBindMintIdentityDefaultsToCaller(t *testing.T) {
	iss, sub, impersonating, err := BindMintIdentity("https://idp.example", "admin-1", "", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if iss != "https://idp.example" || sub != "admin-1" || impersonating {
		t.Fatalf("got %s %s impersonating=%v", iss, sub, impersonating)
	}
}

func TestBindMintIdentityMatchingCallerOK(t *testing.T) {
	iss, sub, impersonating, err := BindMintIdentity("https://idp.example", "admin-1", "https://idp.example", "admin-1", false)
	if err != nil || impersonating || iss != "https://idp.example" || sub != "admin-1" {
		t.Fatalf("matching caller: %s %s %v %v", iss, sub, impersonating, err)
	}
}

func TestBindMintIdentityRejectsForeignSubjectWithoutPermission(t *testing.T) {
	_, _, _, err := BindMintIdentity("https://idp.example", "admin-1", "", "other-user", false)
	if err != ErrMintImpersonation {
		t.Fatalf("foreign subject: %v", err)
	}
}

func TestBindMintIdentityRejectsIssuerSpoofEvenWithPermission(t *testing.T) {
	_, _, _, err := BindMintIdentity("https://idp.example", "admin-1", "https://hostile.example", "", true)
	if err != ErrMintIssuerSpoof {
		t.Fatalf("issuer spoof: %v", err)
	}
}

func TestBindMintIdentityAllowsForeignSubjectWithPermission(t *testing.T) {
	iss, sub, impersonating, err := BindMintIdentity("https://idp.example", "admin-1", "", "other-user", true)
	if err != nil {
		t.Fatal(err)
	}
	if iss != "https://idp.example" || sub != "other-user" || !impersonating {
		t.Fatalf("got %s %s impersonating=%v", iss, sub, impersonating)
	}
}

func TestCanEmbedImpersonateUsesPlatformAllowlist(t *testing.T) {
	allow := []PrincipalRef{{Issuer: "https://idp.example", Subject: "ops-1"}}
	if !CanEmbedImpersonate("https://idp.example", "ops-1", allow) {
		t.Fatal("platform-admin should impersonate")
	}
	if CanEmbedImpersonate("https://idp.example", "admin-1", allow) {
		t.Fatal("workspace admin must not impersonate")
	}
	if CanEmbedImpersonate("https://idp.example", "ops-1", nil) {
		t.Fatal("empty PLATFORM_ADMINS is fail-closed")
	}
}
