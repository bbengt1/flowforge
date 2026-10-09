package wfstore

import (
	"errors"
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

func TestPrepareStartRefusesSystemUnlessSystemTrigger(t *testing.T) {
	const (
		ws  = "11111111-1111-4111-8111-111111111111"
		wf  = "44444444-4444-4444-8444-444444444444"
		ver = "33333333-3333-4333-8333-333333333333"
	)
	sys, err := isolation.AuthorizeSystem(ws)
	if err != nil {
		t.Fatal(err)
	}
	person, err := isolation.Authorize(ws, "22222222-2222-4222-8222-222222222222")
	if err != nil {
		t.Fatal(err)
	}
	for _, trig := range []string{"manual", "api", "", "cron"} {
		_, err := prepareStart(sys, wf, StartInput{VersionID: ver, TriggerType: trig})
		if !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q start = %v, want ErrInvalid", trig, err)
		}
	}
	for _, trig := range []string{"schedule", "webhook", "resync"} {
		if _, err := prepareStart(sys, wf, StartInput{VersionID: ver, TriggerType: trig}); err != nil {
			t.Fatalf("%s: %v", trig, err)
		}
	}
	if _, err := prepareStart(person, wf, StartInput{VersionID: ver, TriggerType: "manual"}); err != nil {
		t.Fatal(err)
	}
}
