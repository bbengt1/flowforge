package parkedapproval

import (
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// #620: a machine principal is never an eligible decider, whatever its
// roles, and never counts toward Targeted or HasDecider.
func TestEligibleRefusesMachinePrincipals(t *testing.T) {
	const person = "https://idp.example"
	if !Eligible("u1", person, "active", "", "approver", []string{"approver"}) {
		t.Fatal("person approver not eligible")
	}
	for _, roles := range [][]string{{"approver"}, {"admin"}, {"approver", "admin"}} {
		if Eligible("m1", authz.MachineIssuer, "active", "", "approver", roles) {
			t.Fatalf("machine with %v is eligible", roles)
		}
	}
	if !IsMachine(authz.MachineIssuer) || IsMachine(person) || IsMachine("") {
		t.Fatal("IsMachine")
	}

	cands := []Candidate{
		{ID: "m1", Named: true, Issuer: authz.MachineIssuer, Status: "active", Roles: []string{"approver", "admin"}},
		{ID: "m2", Issuer: authz.MachineIssuer, Status: "active", Roles: []string{"approver"}},
	}
	called := false
	snap, err := BuildSnapshot("r", "approver", []string{"g1"}, cands, func() (bool, error) { called = true; return false, nil })
	if err != nil || snap.Targeted || snap.HasDecider || len(snap.Users) != 0 || !called {
		t.Fatalf("machine-only snapshot = %+v err=%v fallbackCalled=%v", snap, err, called)
	}
	cands = append(cands, Candidate{ID: "h1", Issuer: person, Status: "active", Roles: []string{"approver"}})
	snap, _ = BuildSnapshot("r", "approver", []string{"g1"}, cands, nil)
	if !snap.Targeted || !snap.HasDecider || len(snap.Users) != 0 {
		t.Fatalf("mixed snapshot = %+v", snap)
	}
}
