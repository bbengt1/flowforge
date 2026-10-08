package identity

import (
	"context"
	"testing"
)

// ResolveApprovalSnapshot applies the shared parkedapproval rule over the
// in-memory store: eligible named users and live group members first, else
// another active admin; the requester never counts.
func TestMemoryResolveApprovalSnapshot(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	tenant, err := m.CreateTenant(ctx, "snap", "Snap")
	if err != nil {
		t.Fatal(err)
	}
	owner, _ := m.UpsertUser(ctx, "https://idp.example", "snap-owner", "Owner")
	ws, err := m.CreateWorkspace(ctx, tenant.ID, "snapwb", "Snap", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	viewer, _ := m.UpsertUser(ctx, "https://idp.example", "snap-viewer", "Viewer")
	approver, _ := m.UpsertUser(ctx, "https://idp.example", "snap-approver", "Approver")
	admin2, _ := m.UpsertUser(ctx, "https://idp.example", "snap-admin2", "Admin 2")
	for id, role := range map[string]string{viewer.ID: "viewer", approver.ID: "approver"} {
		if err := m.SetMemberRoles(ctx, ws.ID, id, []string{role}, MemberActor{Via: MemberViaSystem}); err != nil {
			t.Fatal(err)
		}
	}
	g, err := m.CreateGroup(ctx, ws.ID, GroupActor{UserID: owner.ID}, "Snap approvers")
	if err != nil {
		t.Fatal(err)
	}
	if err := m.AddGroupMember(ctx, ws.ID, GroupActor{UserID: owner.ID}, g.ID, viewer.ID); err != nil {
		t.Fatal(err)
	}
	missing := "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b"

	snap, err := m.ResolveApprovalSnapshot(ctx, ws.ID, owner.ID, "approver", []string{owner.ID}, []string{g.ID, missing})
	if err != nil {
		t.Fatal(err)
	}
	if snap.HasDecider || snap.Targeted || len(snap.Users) != 0 || len(snap.Groups) != 1 || snap.Groups[0] != g.ID {
		t.Fatalf("requester-only snapshot = %+v", snap)
	}

	if err := m.AddGroupMember(ctx, ws.ID, GroupActor{UserID: owner.ID}, g.ID, approver.ID); err != nil {
		t.Fatal(err)
	}
	snap, _ = m.ResolveApprovalSnapshot(ctx, ws.ID, owner.ID, "approver", nil, []string{g.ID})
	if !snap.HasDecider || !snap.Targeted || len(snap.Users) != 0 {
		t.Fatalf("group member snapshot = %+v", snap)
	}

	if err := m.SetUserStatus(ctx, approver.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	snap, _ = m.ResolveApprovalSnapshot(ctx, ws.ID, owner.ID, "approver", []string{approver.ID}, []string{g.ID})
	if snap.HasDecider {
		t.Fatalf("disabled approver counted: %+v", snap)
	}

	if err := m.SetMemberRoles(ctx, ws.ID, admin2.ID, []string{"admin"}, MemberActor{Via: MemberViaSystem}); err != nil {
		t.Fatal(err)
	}
	snap, _ = m.ResolveApprovalSnapshot(ctx, ws.ID, owner.ID, "approver", nil, []string{g.ID})
	if !snap.HasDecider || snap.Targeted {
		t.Fatalf("second admin snapshot = %+v", snap)
	}
}
