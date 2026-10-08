package wfstore

import (
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
)

func TestSystemScopeKeepsActorNullAndStampsVia(t *testing.T) {
	scope, err := isolation.AuthorizeSystem("11111111-1111-4111-8111-111111111111")
	if err != nil {
		t.Fatal(err)
	}
	if actorArg(scope) != nil {
		t.Fatalf("actorArg = %#v, want NULL", actorArg(scope))
	}
	ev := newAudit(scope, AuditWrite{Action: "execution.start", Details: map[string]any{"outcome": "created"}}, time.Unix(1, 0).UTC())
	if ev.ActorID != "" {
		t.Fatalf("actor id = %q", ev.ActorID)
	}
	if ev.Details["via"] != identity.MemberViaSystem {
		t.Fatalf("via = %v", ev.Details["via"])
	}
	hook := newAudit(scope, AuditWrite{Action: "execution.start", Details: map[string]any{"via": "webhook", "triggerId": "trig-1"}}, time.Unix(1, 0).UTC())
	if hook.Details["via"] != "webhook" || hook.Details["triggerId"] != "trig-1" {
		t.Fatalf("webhook audit = %#v", hook.Details)
	}
	if _, ok := hook.Details["secret"]; ok {
		t.Fatal("secret key")
	}
	if _, ok := hook.Details["signature"]; ok {
		t.Fatal("signature key")
	}
}
