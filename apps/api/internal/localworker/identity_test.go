package localworker

import (
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestIdentityDefaultsToDedicatedPrincipal(t *testing.T) {
	got := Identity("", "")
	if got.Issuer != DefaultIssuer || got.Subject != DefaultSubject {
		t.Fatalf("default = %+v", got)
	}
	if got.Subject == "admin-1" {
		t.Fatal("worker must not default to the human seed admin")
	}
	if got := Identity(" https://other.example ", ""); got.Issuer != "https://other.example" || got.Subject != DefaultSubject {
		t.Fatalf("issuer override = %+v", got)
	}
	if got := Identity("", "ci-worker"); got.Issuer != DefaultIssuer || got.Subject != "ci-worker" {
		t.Fatalf("subject override = %+v", got)
	}
}

func TestWorkerRoleIsMinimal(t *testing.T) {
	perms := authz.ExpandWorkspaceRoles([]string{WorkerRole})
	if !authz.Allows(perms, authz.PermWorkflowExecute) {
		t.Fatal("worker role must grant workflow.execute (claim)")
	}
	for _, p := range []string{authz.PermApprovalDecide, authz.PermWorkspaceAdminister, authz.PermWorkflowEdit, authz.PermWorkflowPublish, authz.PermCredentialManage} {
		if authz.Allows(perms, p) {
			t.Fatalf("worker role grants %s", p)
		}
	}
	// No smaller catalog role can claim: every other role with
	// workflow.execute is admin.
	for _, r := range authz.Roles() {
		if r.Key == WorkerRole || r.Key == authz.RoleAdmin || r.Key == authz.RolePlatformAdmin {
			continue
		}
		if authz.Allows(authz.ExpandWorkspaceRoles([]string{r.Key}), authz.PermWorkflowExecute) {
			t.Fatalf("role %s also grants workflow.execute; reconsider the worker role", r.Key)
		}
	}
}

func TestBindingEnabled(t *testing.T) {
	cases := []struct {
		name, flag, env  string
		tls, trust, want bool
	}{
		{"compose default", "", "development", false, true, true},
		{"explicit on", "1", "development", false, true, true},
		{"opt out", "0", "development", false, true, false},
		{"no trusted headers", "", "development", false, false, false},
		{"production", "", "production", false, true, false},
		{"empty app env", "", "", false, true, false},
		{"require tls", "", "development", true, true, false},
		{"explicit on in production", "1", "production", false, true, false},
	}
	for _, tc := range cases {
		if got := BindingEnabled(tc.flag, tc.env, tc.tls, tc.trust); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}
