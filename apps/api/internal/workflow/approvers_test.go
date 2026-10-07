package workflow

import (
	"fmt"
	"strings"
	"testing"
)

func approversGateYAML(role, approvers string) string {
	return `apiVersion: flowforge/v1
kind: Workflow
metadata:
  name: approvers-validation
spec:
  triggers:
    - id: manual
      type: manual
  nodes:
    - id: gate
      type: flow.approval
      name: Gate
      with:
        approverRole: ` + role + `
        expiresIn: PT1H
` + approvers + `
  edges: []
`
}

func approverIDs(n int) string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf(`"00000000-0000-4000-8000-%012d"`, i+1)
	}
	return "[" + strings.Join(out, ", ") + "]"
}

func TestValidateApprovers(t *testing.T) {
	const u1 = "11111111-1111-4111-8111-111111111111"
	const g1 = "22222222-2222-4222-8222-222222222222"
	cases := []struct {
		name, role, approvers, path, code string
	}{
		{"users and groups", "approver", "        approvers:\n          users: [\"" + u1 + "\"]\n          groups: [\"" + g1 + "\"]", "", ""},
		{"groups only", "approver", "        approvers:\n          groups: [\"" + g1 + "\"]", "", ""},
		{"empty", "approver", "        approvers:\n          users: []\n          groups: []", "spec.nodes[0].with.approvers", CodeInvalidWith},
		{"not an object", "approver", "        approvers: [\"" + u1 + "\"]", "spec.nodes[0].with.approvers", CodeInvalidType},
		{"unknown key", "approver", "        approvers:\n          roles: [\"" + u1 + "\"]\n          users: [\"" + u1 + "\"]", "spec.nodes[0].with.approvers.roles", CodeUnknownField},
		{"bad uuid", "approver", "        approvers:\n          users: [\"alice\"]", "spec.nodes[0].with.approvers.users[0]", CodeInvalidUUID},
		{"duplicate", "approver", "        approvers:\n          users: [\"" + u1 + "\", \"" + strings.ToUpper(u1) + "\"]", "spec.nodes[0].with.approvers.users[1]", CodeInvalidWith},
		{"25 is the cap", "approver", "        approvers:\n          users: " + approverIDs(25), "", ""},
		{"26 is too many", "approver", "        approvers:\n          users: " + approverIDs(26), "spec.nodes[0].with.approvers", CodeInvalidWith},
		{"unknown role when targeted", "release-captain", "        approvers:\n          users: [\"" + u1 + "\"]", "spec.nodes[0].with.approverRole", CodeInvalidWith},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, errs := ParseAndNormalize([]byte(approversGateYAML(tc.role, tc.approvers)))
			if tc.code == "" {
				if len(errs) > 0 {
					t.Fatalf("errs = %+v", errs)
				}
				return
			}
			for _, e := range errs {
				if e.Path == tc.path && e.Code == tc.code {
					return
				}
			}
			t.Fatalf("want %s %s, got %+v", tc.path, tc.code, errs)
		})
	}
}

func TestApprovalApproversReadsSnapshotInput(t *testing.T) {
	users, groups, targeted := ApprovalApprovers(map[string]any{"approvers": map[string]any{
		"users":  []any{"11111111-1111-4111-8111-111111111111", " 11111111-1111-4111-8111-111111111111 "},
		"groups": []any{"22222222-2222-4222-8222-22222222222A"},
	}})
	if !targeted || len(users) != 1 || len(groups) != 1 || groups[0] != "22222222-2222-4222-8222-22222222222a" {
		t.Fatalf("users=%v groups=%v targeted=%v", users, groups, targeted)
	}
	if _, _, targeted := ApprovalApprovers(map[string]any{"approverRole": "approver"}); targeted {
		t.Fatal("no approvers key must not be targeted")
	}
}
