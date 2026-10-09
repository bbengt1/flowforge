package identity

import (
	"context"
	"slices"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// #627: the memory store records the same creator-grant row Postgres
// writes, and a refused create records none.
func TestMemoryCreateWorkspaceAuditsCreatorGrant(t *testing.T) {
	ctx := context.Background()
	m := NewMemory()
	tenant, err := m.CreateTenant(ctx, "mem-cg", "Tenant")
	if err != nil {
		t.Fatal(err)
	}
	creator, err := m.UpsertUser(ctx, "https://idp.example", "creator", "Casey Creator")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.CreateWorkspace(ctx, tenant.ID, "bad key!", "x", creator.ID); err == nil {
		t.Fatal("invalid key accepted")
	}
	if len(m.MemberAudit()) != 0 {
		t.Fatalf("refused create audited: %+v", m.MemberAudit())
	}
	ws, err := m.CreateWorkspace(ctx, tenant.ID, "mem-cg", "Creator Grant", creator.ID)
	if err != nil {
		t.Fatal(err)
	}
	rows := m.MemberAudit()
	if len(rows) != 1 {
		t.Fatalf("rows = %+v", rows)
	}
	r := rows[0]
	if r.WorkspaceID != ws.ID || r.Action != AuditMemberRolesChange || r.UserID != creator.ID || r.ActorUserID != creator.ID ||
		len(r.RolesBefore) != 0 || r.RolesBefore == nil || !slices.Equal(r.RolesAfter, []string{authz.RoleAdmin}) ||
		r.DisplayName != "Casey Creator" || r.ActorDisplay != "Casey Creator" {
		t.Fatalf("row = %+v", r)
	}
}
