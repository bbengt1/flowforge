package authz

import (
	"slices"
	"testing"
)

func TestMatrixCoversRequiredFamilies(t *testing.T) {
	seen := map[string]bool{}
	for _, p := range Permissions() {
		if p.Key == "" || p.Family == "" {
			t.Fatalf("empty catalog entry: %+v", p)
		}
		if !slices.Contains(RequiredFamilies(), p.Family) {
			t.Fatalf("permission %s has undocumented family %s", p.Key, p.Family)
		}
		seen[p.Family] = true
	}
	for _, family := range RequiredFamilies() {
		if !seen[family] {
			t.Fatalf("permission matrix missing family %s", family)
		}
	}
}

func TestAllowsDenyByDefault(t *testing.T) {
	granted := []string{PermWorkflowView, PermWorkflowEdit}
	if !Allows(granted, PermWorkflowView) {
		t.Fatal("granted view should be allowed")
	}
	if Allows(granted, PermWorkflowPublish) {
		t.Fatal("ungranted publish must be denied")
	}
	if Allows(granted, PermWorkflowExecute) {
		t.Fatal("ungranted execute must be denied")
	}
	if Allows(granted, PermCredentialManage) {
		t.Fatal("ungranted credential manage must be denied")
	}
	if Allows(granted, PermApprovalDecide) {
		t.Fatal("ungranted approval decide must be denied")
	}
	if Allows(granted, PermWorkspaceAdminister) {
		t.Fatal("ungranted administer must be denied")
	}
	if Allows(nil, PermWorkflowView) {
		t.Fatal("empty grants must deny")
	}
	if Allows(granted, "") {
		t.Fatal("empty action must deny")
	}
	if Allows(granted, "not.a.real.permission") {
		t.Fatal("unknown action must deny")
	}
	if Allows([]string{"not.a.real.permission"}, "not.a.real.permission") {
		t.Fatal("unknown granted action must still deny")
	}
}

func TestViewerCannotPerformPrivilegedActions(t *testing.T) {
	granted := ExpandRoles([]string{RoleViewer})
	for _, action := range []string{
		PermWorkflowEdit, PermWorkflowPublish, PermWorkflowExecute,
		PermCredentialUse, PermCredentialManage, PermApprovalDecide,
		PermWorkspaceAdminister, PermKubernetesApply, PermKubernetesRead, PermSSHRun, PermScriptRun,
		PermScriptRevoke, PermScriptEmergencyStop, PermAlertAck,
	} {
		if Allows(granted, action) {
			t.Fatalf("viewer must not have %s", action)
		}
	}
	if !Allows(granted, PermWorkflowView) {
		t.Fatal("viewer should view workflows")
	}
}

func TestAdminHasEveryCatalogPermission(t *testing.T) {
	granted := ExpandRoles([]string{RoleAdmin})
	for _, p := range Permissions() {
		if !Allows(granted, p.Key) {
			t.Fatalf("admin missing %s", p.Key)
		}
	}
}

func TestUnknownRoleExpandsToNothing(t *testing.T) {
	if got := ExpandRoles([]string{"not-a-role"}); len(got) != 0 {
		t.Fatalf("got %v", got)
	}
}

func TestKnown(t *testing.T) {
	if !Known(PermWorkflowView) || Known("nope") {
		t.Fatal("Known mismatch")
	}
	if !KnownRole(RoleAdmin) || KnownRole("root") {
		t.Fatal("KnownRole mismatch")
	}
}
