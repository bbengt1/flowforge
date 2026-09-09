package embed

import (
	"strings"
	"testing"
)

func TestMemoryAuditorRecordsSecretFreeEvents(t *testing.T) {
	a := NewMemoryAuditor()
	a.Record(AuthzEvent{
		EventType: EventMinted,
		Outcome:   "allowed",
		Reason:    ReasonImpersonated,
		JTI:       "jti-1",
		Kid:       "kid-1",
		Issuer:    "https://idp.example",
		Subject:   "ops-1",
		TenantID:  "11111111-1111-1111-1111-111111111111",
	})
	a.Record(AuthzEvent{
		EventType: EventRejected,
		Outcome:   "denied",
		Reason:    ReasonCapability,
		Issuer:    "https://idp.example",
		Subject:   "ops-1",
	})
	if !a.Contains(EventMinted, "allowed", ReasonImpersonated) {
		t.Fatal("missing impersonated mint allow")
	}
	if !a.Contains(EventRejected, "denied", ReasonCapability) {
		t.Fatal("missing capability deny")
	}
	for _, ev := range a.Events() {
		if len(ev.SecretFields()) != 0 {
			t.Fatalf("secret fields on %+v", ev)
		}
		raw := ev.EventType + ev.Outcome + ev.Reason + ev.JTI + ev.Kid + ev.Issuer + ev.Subject
		for _, leak := range []string{"assertion", "private_key", "ff_session", "BEGIN"} {
			if strings.Contains(raw, leak) {
				t.Fatalf("secret-shaped %q in audit payload %+v", leak, ev)
			}
		}
	}
}

func TestNilAuditorIsSafe(t *testing.T) {
	var a *MemoryAuditor
	a.Record(AuthzEvent{EventType: EventRejected, Outcome: "denied", Reason: ReasonIssuer})
	if a.Contains(EventRejected, "denied", ReasonIssuer) {
		t.Fatal("nil auditor should not contain events")
	}
	if a.Events() != nil {
		t.Fatal("nil auditor events")
	}
}
