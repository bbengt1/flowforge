package identity

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestNormalizeGroupName(t *testing.T) {
	for in, want := range map[string]string{
		"  Ops  ":                 "Ops",
		strings.Repeat("é", 128):  strings.Repeat("é", 128),
		"Change Advisory Board 2": "Change Advisory Board 2",
	} {
		got, err := NormalizeGroupName(in)
		if err != nil || got != want {
			t.Fatalf("NormalizeGroupName(%q) = %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "  ", strings.Repeat("x", 129), "tab\tinside", "nul\x00"} {
		if _, err := NormalizeGroupName(bad); !errors.Is(err, ErrGroupNameInvalid) {
			t.Fatalf("NormalizeGroupName(%q) = %v", bad, err)
		}
	}
}

func TestMemberCanApprove(t *testing.T) {
	cases := []struct {
		status string
		roles  []string
		want   bool
	}{
		{"active", []string{authz.RoleApprover}, true},
		{"active", []string{authz.RoleAdmin}, true},
		{"active", []string{authz.RoleViewer, authz.RoleEditor}, false},
		{"active", nil, false},
		{"disabled", []string{authz.RoleApprover}, false},
		{"active", []string{authz.RolePlatformAdmin}, false},
	}
	for _, c := range cases {
		if got := memberCanApprove(c.status, c.roles); got != c.want {
			t.Fatalf("memberCanApprove(%s, %v) = %v", c.status, c.roles, got)
		}
	}
}

func TestMemoryGroupsMirrorPostgresRules(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	owner, _ := m.UpsertUser(ctx, "https://idp.example", "owner", "Owner")
	tenant, _ := m.CreateTenant(ctx, "acme", "Acme")
	ws, err := m.CreateWorkspace(ctx, tenant.ID, "ops", "Ops", owner.ID)
	if err != nil {
		t.Fatal(err)
	}
	approver, _ := m.UpsertUser(ctx, "https://idp.example", "approver", "Approver")
	if err := m.SetMemberRoles(ctx, ws.ID, approver.ID, []string{authz.RoleApprover}); err != nil {
		t.Fatal(err)
	}
	unbound, _ := m.UpsertUser(ctx, "https://idp.example", "unbound", "Unbound")
	actor := GroupActor{UserID: owner.ID}

	g, err := m.CreateGroup(ctx, ws.ID, actor, "Board")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.CreateGroup(ctx, ws.ID, actor, "BOARD"); !errors.Is(err, ErrGroupNameTaken) {
		t.Fatalf("clash = %v", err)
	}
	if err := m.AddGroupMember(ctx, ws.ID, actor, g.ID, unbound.ID); !errors.Is(err, ErrGroupMemberNotInWorkspace) {
		t.Fatalf("unbound add = %v", err)
	}
	for i := 0; i < 2; i++ {
		if err := m.AddGroupMember(ctx, ws.ID, actor, g.ID, approver.ID); err != nil {
			t.Fatal(err)
		}
	}
	in, _ := m.InTargetGroups(ctx, ws.ID, approver.ID, []string{g.ID})
	users, _ := m.ResolveTargetUsers(ctx, ws.ID, []string{g.ID}, nil)
	if !in || !slices.Equal(users, []string{approver.ID}) {
		t.Fatalf("helpers in=%v users=%v", in, users)
	}

	if err := m.SetUserStatus(ctx, approver.ID, "disabled"); err != nil {
		t.Fatal(err)
	}
	in, _ = m.InTargetGroups(ctx, ws.ID, approver.ID, []string{g.ID})
	users, _ = m.ResolveTargetUsers(ctx, ws.ID, []string{g.ID}, []string{approver.ID})
	d, _ := m.GetGroup(ctx, ws.ID, g.ID)
	if in || len(users) != 0 || len(d.Members) != 1 || d.Members[0].CanApprove {
		t.Fatalf("disabled: in=%v users=%v detail=%+v", in, users, d)
	}
	if err := m.SetUserStatus(ctx, approver.ID, "active"); err != nil {
		t.Fatal(err)
	}

	if err := m.RemoveMember(ctx, ws.ID, approver.ID); err != nil {
		t.Fatal(err)
	}
	d, _ = m.GetGroup(ctx, ws.ID, g.ID)
	if len(d.Members) != 0 {
		t.Fatalf("RemoveMember left rows: %+v", d.Members)
	}

	if err := m.DeleteGroup(ctx, ws.ID, actor, g.ID); err != nil {
		t.Fatal(err)
	}
	if in, _ := m.InTargetGroups(ctx, ws.ID, owner.ID, []string{g.ID}); in {
		t.Fatal("deleted group matched")
	}
	var actions []string
	for _, a := range m.GroupAudit() {
		actions = append(actions, a.Action)
	}
	want := []string{AuditGroupCreate, AuditGroupMemberAdd, AuditGroupDelete}
	if !slices.Equal(actions, want) {
		t.Fatalf("audit = %v, want %v", actions, want)
	}
}
