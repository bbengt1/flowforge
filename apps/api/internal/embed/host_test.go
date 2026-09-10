package embed

import "testing"

func TestBindHostIssuerFailsClosed(t *testing.T) {
	allow := []string{"https://idp.example"}
	if err := BindHostIssuer("https://idp.example", "https://idp.example", "https://idp.example", allow); err != nil {
		t.Fatalf("matching host: %v", err)
	}
	if err := BindHostIssuer("https://idp.example", "", "", allow); err != nil {
		t.Fatalf("single allowlist without header: %v", err)
	}
	if err := BindHostIssuer("https://idp.example", "https://other.example", "https://idp.example", allow); err != ErrHostIssuer {
		t.Fatalf("host claim mismatch: %v", err)
	}
	if err := BindHostIssuer("https://idp.example", "https://idp.example", "https://portal.example", allow); err != ErrHostIssuer {
		t.Fatalf("wrong expected host: %v", err)
	}
	if err := BindHostIssuer("https://hostile.example", "", "https://hostile.example", allow); err != ErrIssuerNotAllowed {
		t.Fatalf("expected host not on allowlist: %v", err)
	}
	if err := BindHostIssuer("https://idp.example", "", "", nil); err != ErrIssuerNotAllowed {
		t.Fatalf("empty allowlist: %v", err)
	}
	both := []string{"https://idp.example", "https://portal.example"}
	if err := BindHostIssuer("https://idp.example", "https://idp.example", "", both); err != ErrHostIssuer {
		t.Fatalf("ambiguous host without binding: %v", err)
	}
	if err := BindHostIssuer("https://idp.example", "https://idp.example", "https://idp.example", both); err != nil {
		t.Fatalf("explicit binding on merged list: %v", err)
	}
}

func TestResolveHostBinding(t *testing.T) {
	got, err := ResolveHostBinding("https://idp.example", HostContextEmbed, "", "")
	if err != nil || got.Issuer != "https://idp.example" || got.Context != HostContextEmbed {
		t.Fatalf("header only: %+v %v", got, err)
	}
	got, err = ResolveHostBinding("", "", "https://portal.example", HostContextPortal)
	if err != nil || got.Issuer != "https://portal.example" || got.Context != HostContextPortal {
		t.Fatalf("body only: %+v %v", got, err)
	}
	if _, err := ResolveHostBinding("https://a.example", "", "https://b.example", ""); err != ErrHostIssuer {
		t.Fatalf("issuer mismatch: %v", err)
	}
	if _, err := ResolveHostBinding("", HostContextEmbed, "", HostContextPortal); err != ErrHostIssuer {
		t.Fatalf("context mismatch: %v", err)
	}
	if _, err := ResolveHostBinding("", "iframe", "", ""); err != ErrHostContext {
		t.Fatalf("unknown context: %v", err)
	}
}

func TestHostAllowlistSelectsPath(t *testing.T) {
	embedIssuers := []string{"https://idp.example"}
	portalIssuers := []string{"https://portal.example"}
	if got := HostAllowlist(HostContextEmbed, embedIssuers, portalIssuers); len(got) != 1 || got[0] != "https://idp.example" {
		t.Fatalf("embed path %v", got)
	}
	if got := HostAllowlist(HostContextPortal, embedIssuers, portalIssuers); len(got) != 1 || got[0] != "https://portal.example" {
		t.Fatalf("portal path %v", got)
	}
	merged := HostAllowlist("", embedIssuers, portalIssuers)
	if len(merged) != 2 || merged[0] != "https://idp.example" || merged[1] != "https://portal.example" {
		t.Fatalf("merged %v", merged)
	}
	if got := HostAllowlist(HostContextPortal, embedIssuers, nil); len(got) != 0 {
		t.Fatalf("empty portal list %v", got)
	}
}
