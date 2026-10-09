package identity

import (
	"context"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/machine"
)

// #620 memory twins: a machine principal is never a targeted group
// member, never an eligible snapshot candidate, never the admin fallback,
// never an enabled person, and never keeps the last-admin guard happy.
func TestMemoryMachinePrincipalIsNotADecider(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	tenant, _ := m.CreateTenant(ctx, "mach", "Mach")
	owner, _ := m.UpsertUser(ctx, "https://idp.example", "mach-owner", "Owner")
	ws, err := m.CreateWorkspace(ctx, tenant.ID, "machwb", "Mach", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	bot, _ := m.UpsertUser(ctx, machine.Issuer, "mach-bot", "Bot")
	if err := m.SetMemberRoles(ctx, ws.ID, bot.ID, []string{"approver", "admin"}, MemberActor{Via: MemberViaSystem}); err != nil {
		t.Fatal(err)
	}
	g, _ := m.CreateGroup(ctx, ws.ID, GroupActor{UserID: owner.ID}, "Bots")
	if err := m.AddGroupMember(ctx, ws.ID, GroupActor{UserID: owner.ID}, g.ID, bot.ID); err != nil {
		t.Fatal(err)
	}
	if in, _ := m.InTargetGroups(ctx, ws.ID, bot.ID, []string{g.ID}); in {
		t.Fatal("machine counted as a targeted group member")
	}
	if ok, _ := m.EnabledPerson(ctx, bot.ID); ok {
		t.Fatal("machine is an enabled person")
	}
	if ok, _ := m.EnabledPerson(ctx, owner.ID); !ok {
		t.Fatal("owner is not an enabled person")
	}
	snap, err := m.ResolveApprovalSnapshot(ctx, ws.ID, owner.ID, "approver", []string{bot.ID}, []string{g.ID})
	if err != nil || snap.Targeted || snap.HasDecider || len(snap.Users) != 0 {
		t.Fatalf("machine snapshot = %+v %v", snap, err)
	}
	if err := m.RemoveMember(ctx, ws.ID, owner.ID, MemberActor{Via: MemberViaSystem}); err != ErrLastAdmin {
		t.Fatalf("remove last human admin = %v, want ErrLastAdmin", err)
	}
	if err := m.RemoveMember(ctx, ws.ID, bot.ID, MemberActor{Via: MemberViaSystem}); err != nil {
		t.Fatalf("remove machine admin = %v", err)
	}
}
