package workflowhttp

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
	"github.com/bbengt1/flowforge/apps/api/internal/workflow"
)

// Publish-time approver error codes (invalid-workflow errors[].code).
const (
	codeApproverGroupNotFound = "approver-group-not-found"
	codeApproverNotMember     = "approver-not-member"
	codeApproverNotPerson     = "approver-not-person"
	codeApproverDisabled      = "approver-disabled"
	codeApproverCannotDecide  = "approver-cannot-decide"
	codeApproverRoleMismatch  = "approver-role-mismatch"
)

var errApproverLookup = errors.New("approver lookup failed")

// validatePublishApprovers checks with.approvers on every flow.approval
// node against this workspace. A group outside the workspace, whether a
// random UUID or another tenant's id, gets the same error. Users must be
// active members, people rather than machine principals, whose roles
// grant approval.decide and meet approverRole. A group that contains
// machine principals still publishes; those members never count.
// Live membership is still checked at decide time; this only catches
// mistakes early.
func validatePublishApprovers(ctx context.Context, s *core.Server, scope isolation.Scope, src string) (workflow.ErrorList, error) {
	doc, perrs := workflow.Parse([]byte(src))
	if len(perrs) > 0 || doc == nil {
		return nil, nil
	}
	var members map[string]identity.Member
	var errs workflow.ErrorList
	for i, n := range doc.Spec.Nodes {
		if n.Type != "flow.approval" {
			continue
		}
		users, groups, targeted := workflow.ApprovalApprovers(n.With)
		if !targeted {
			continue
		}
		base := fmt.Sprintf("spec.nodes[%d].with.approvers", i)
		role, _ := n.With["approverRole"].(string)
		role = strings.TrimSpace(role)
		if len(users) > 0 && members == nil {
			list, err := s.Store.ListMembers(ctx, scope.WorkspaceID())
			if err != nil {
				return nil, errApproverLookup
			}
			members = make(map[string]identity.Member, len(list))
			for _, m := range list {
				members[strings.ToLower(m.User.ID)] = m
			}
		}
		for j, id := range users {
			path := fmt.Sprintf("%s.users[%d]", base, j)
			m, ok := members[id]
			switch {
			case !ok:
				errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverNotMember, Message: "This approver is not a member of the workspace."})
			case parkedapproval.IsMachine(m.User.Issuer):
				errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverNotPerson, Message: "This approver is a machine account. Only a person can approve this step."})
			case m.User.Status != "" && m.User.Status != "active":
				errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverDisabled, Message: "This approver's account is disabled."})
			case !authz.Allows(authz.ExpandWorkspaceRoles(m.Roles), authz.PermApprovalDecide):
				errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverCannotDecide, Message: "This approver's roles do not grant approval decisions."})
			case !approval.HasApproverRole(m.Roles, role):
				errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverRoleMismatch, Message: "This approver does not hold the gate's approver role."})
			}
		}
		if len(groups) == 0 {
			continue
		}
		gs, ok := s.Store.(identity.GroupStore)
		for j, id := range groups {
			path := fmt.Sprintf("%s.groups[%d]", base, j)
			if !ok {
				errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverGroupNotFound, Message: "This group is not in the workspace."})
				continue
			}
			if _, err := gs.GetGroup(ctx, scope.WorkspaceID(), id); err != nil {
				if errors.Is(err, identity.ErrNotFound) {
					errs = append(errs, workflow.FieldError{Path: path, Code: codeApproverGroupNotFound, Message: "This group is not in the workspace."})
					continue
				}
				return nil, errApproverLookup
			}
		}
	}
	return errs, nil
}
