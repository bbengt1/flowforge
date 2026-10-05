package runner

import (
	"errors"
	"testing"
)

func TestResolveIdentityProductionRefusesPlatformAdminFallback(t *testing.T) {
	_, _, _, err := ResolveIdentity(IdentityConfig{
		ProductionLocked: true,
		PlatformAdmins:   "https://idp.example|admin-1",
	})
	if !errors.Is(err, ErrProductionIdentityRequired) {
		t.Fatalf("err = %v", err)
	}

	_, _, _, err = ResolveIdentity(IdentityConfig{
		ProductionLocked: true,
		Issuer:           "https://idp.example",
		PlatformAdmins:   "https://idp.example|admin-1",
	})
	if !errors.Is(err, ErrProductionIdentityRequired) {
		t.Fatalf("partial issuer err = %v", err)
	}
}

func TestResolveIdentityExplicitPrincipal(t *testing.T) {
	userID, issuer, subject, err := ResolveIdentity(IdentityConfig{
		ProductionLocked: true,
		UserID:           "00000000-0000-4000-8000-000000000001",
		PlatformAdmins:   "https://idp.example|admin-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if userID != "00000000-0000-4000-8000-000000000001" || issuer != "" || subject != "" {
		t.Fatalf("got %q %q %q", userID, issuer, subject)
	}

	userID, issuer, subject, err = ResolveIdentity(IdentityConfig{
		ProductionLocked: true,
		Issuer:           "https://idp.example",
		Subject:          "runner-1",
		PlatformAdmins:   "https://idp.example|admin-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if userID != "" || issuer != "https://idp.example" || subject != "runner-1" {
		t.Fatalf("got %q %q %q", userID, issuer, subject)
	}
}

func TestResolveIdentityNonProductionKeepsPlatformAdminFallback(t *testing.T) {
	userID, issuer, subject, err := ResolveIdentity(IdentityConfig{
		PlatformAdmins: "https://idp.example|admin-1,https://idp.example|admin-2",
	})
	if err != nil {
		t.Fatal(err)
	}
	if userID != "" || issuer != "https://idp.example" || subject != "admin-1" {
		t.Fatalf("fallback = %q %q %q", userID, issuer, subject)
	}

	userID, issuer, subject, err = ResolveIdentity(IdentityConfig{
		UserID:         "00000000-0000-4000-8000-000000000002",
		PlatformAdmins: "https://idp.example|admin-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if userID != "00000000-0000-4000-8000-000000000002" || issuer != "" || subject != "" {
		t.Fatalf("explicit non-prod = %q %q %q", userID, issuer, subject)
	}

	userID, issuer, subject, err = ResolveIdentity(IdentityConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if userID != "" || issuer != "" || subject != "" {
		t.Fatalf("empty non-prod = %q %q %q", userID, issuer, subject)
	}
}
