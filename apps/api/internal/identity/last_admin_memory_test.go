package identity

import (
	"context"
	"errors"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// The memory store mirrors the Postgres last-admin guard: at least one
// admin role must remain, and a change to an enabled admin must leave an
// enabled admin. A workspace that already has only disabled admins can
// still change its other members.
func TestMemoryLastAdminGuardIgnoresDisabledAdmins(t *testing.T) {
	ctx := context.Background()
	type ws struct {
		m                          *Memory
		id                         string
		active, disabled, nonAdmin User
	}
	setup := func(t *testing.T) ws {
		t.Helper()
		m := NewMemory()
		a, _ := m.UpsertUser(ctx, "https://idp.example", "a", "A")
		tenant, _ := m.CreateTenant(ctx, "acme", "Acme")
		w, err := m.CreateWorkspace(ctx, tenant.ID, "ops", "Ops", a.ID)
		if err != nil {
			t.Fatal(err)
		}
		d, _ := m.UpsertUser(ctx, "https://idp.example", "d", "D")
		n, _ := m.UpsertUser(ctx, "https://idp.example", "n", "N")
		for _, step := range []error{
			m.SetMemberRoles(ctx, w.ID, a.ID, []string{authz.RoleAdmin}, MemberActor{Via: MemberViaSystem}),
			m.SetMemberRoles(ctx, w.ID, d.ID, []string{authz.RoleAdmin}, MemberActor{Via: MemberViaSystem}),
			m.SetMemberRoles(ctx, w.ID, n.ID, []string{authz.RoleViewer}, MemberActor{Via: MemberViaSystem}),
			m.SetUserStatus(ctx, d.ID, "disabled"),
		} {
			if step != nil {
				t.Fatal(step)
			}
		}
		return ws{m: m, id: w.ID, active: a, disabled: d, nonAdmin: n}
	}
	cases := []struct {
		name string
		run  func(w ws) error
		want error
	}{
		{"remove last enabled admin while a disabled admin remains", func(w ws) error {
			return w.m.RemoveMember(ctx, w.id, w.active.ID, MemberActor{Via: MemberViaSystem})
		}, ErrLastAdmin},
		{"demote last enabled admin while a disabled admin remains", func(w ws) error {
			return w.m.SetMemberRoles(ctx, w.id, w.active.ID, []string{authz.RoleViewer}, MemberActor{Via: MemberViaSystem})
		}, ErrLastAdmin},
		{"remove the disabled admin while an enabled admin remains", func(w ws) error {
			return w.m.RemoveMember(ctx, w.id, w.disabled.ID, MemberActor{Via: MemberViaSystem})
		}, nil},
		{"remove a non-admin in a workspace with only disabled admins", func(w ws) error {
			if err := w.m.SetUserStatus(ctx, w.active.ID, "disabled"); err != nil {
				return err
			}
			return w.m.RemoveMember(ctx, w.id, w.nonAdmin.ID, MemberActor{Via: MemberViaSystem})
		}, nil},
		{"remove the only admin role holder (disabled)", func(w ws) error {
			if err := w.m.RemoveMember(ctx, w.id, w.disabled.ID, MemberActor{Via: MemberViaSystem}); err != nil {
				return err
			}
			if err := w.m.SetUserStatus(ctx, w.active.ID, "disabled"); err != nil {
				return err
			}
			return w.m.RemoveMember(ctx, w.id, w.active.ID, MemberActor{Via: MemberViaSystem})
		}, ErrLastAdmin},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := c.run(setup(t)); !errors.Is(err, c.want) {
				t.Fatalf("err = %v, want %v", err, c.want)
			}
		})
	}
}
