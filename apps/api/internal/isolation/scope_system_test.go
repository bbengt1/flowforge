package isolation

import (
	"errors"
	"testing"
)

func TestAuthorizeRefusesEmptyActorAndSystemHelpers(t *testing.T) {
	const (
		ws     = "11111111-1111-4111-8111-111111111111"
		actor  = "22222222-2222-4222-8222-222222222222"
		tenant = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	)
	if _, err := Authorize(ws, ""); !errors.Is(err, ErrNoActor) {
		t.Fatalf("empty actor = %v", err)
	}
	if _, err := Authorize(ws, "  "); !errors.Is(err, ErrNoActor) {
		t.Fatalf("blank actor = %v", err)
	}
	if _, err := AuthorizeTenancy(ws, "", tenant, "ops"); !errors.Is(err, ErrNoActor) {
		t.Fatalf("tenancy empty actor = %v", err)
	}
	person, err := AuthorizeTenancy(ws, actor, tenant, "ops")
	if err != nil {
		t.Fatal(err)
	}
	if person.System() || person.ActorID() != actor {
		t.Fatalf("person scope system=%v actor=%q", person.System(), person.ActorID())
	}

	sys, err := AuthorizeSystem(ws)
	if err != nil {
		t.Fatal(err)
	}
	if !sys.System() || sys.ActorID() != "" || sys.WorkspaceID() != ws || sys.Zero() {
		t.Fatalf("system = %+v actor=%q", sys, sys.ActorID())
	}
	ten, err := AuthorizeSystemTenancy(ws, tenant, "ops")
	if err != nil {
		t.Fatal(err)
	}
	if !ten.System() || ten.ActorID() != "" || ten.TenantID() != tenant || ten.WorkbenchKey() != "ops" {
		t.Fatalf("system tenancy actor=%q tenant=%q key=%q", ten.ActorID(), ten.TenantID(), ten.WorkbenchKey())
	}
	if _, err := AuthorizeSystem(""); !errors.Is(err, ErrNoScope) {
		t.Fatalf("system without workspace = %v", err)
	}
}

func TestZeroScopeIsRefused(t *testing.T) {
	var zero Scope
	if !zero.Zero() || zero.System() || zero.ActorID() != "" {
		t.Fatal("zero value must not look authorized")
	}
	if _, err := Authorize("", "22222222-2222-4222-8222-222222222222"); !errors.Is(err, ErrNoScope) {
		t.Fatalf("empty workspace = %v", err)
	}
}
