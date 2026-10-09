package approvalhttp

import (
	"context"

	"github.com/bbengt1/flowforge/apps/api/internal/approval"
	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/parkedapproval"
)

// presentApprovals fills approvers (display names for a targeted
// snapshot) and the caller's capabilities. Read-only; decide re-checks
// everything under the row lock. A failed live group lookup reports the
// gate as not targeting the caller (fail closed). A machine principal
// never decides (decide refuses it on every route), so its capability is
// always denied.
func presentApprovals(s *core.Server, ctx context.Context, scope isolation.Scope, user identity.User, roles []string, recs []approval.Record) []approval.Record {
	if len(recs) == 0 {
		return recs
	}
	userID := user.ID
	machine := parkedapproval.IsMachine(user.Issuer)
	var targets map[string]bool
	if s.Approvals != nil {
		targets, _ = s.Approvals.TargetsCaller(ctx, scope, recs, userID)
	}
	names := principalNames{s: s, ctx: ctx, workspaceID: scope.WorkspaceID(), users: map[string]string{}, groups: map[string]string{}}
	out := make([]approval.Record, len(recs))
	for i, rec := range recs {
		if rec.Targeted() {
			rec.Approvers = names.approvers(rec)
		}
		capability := DecideCapability(rec, userID, roles, targets[rec.ID])
		if machine && capability.Allowed {
			capability = approval.DecideCapability{Allowed: false, Code: approval.CapMissingPermission, Reason: "Machine accounts cannot decide approvals. Only a person can approve."}
		}
		rec.Capabilities = &approval.Capabilities{Decide: capability}
		out[i] = rec
	}
	return out
}

func presentApproval(s *core.Server, ctx context.Context, scope isolation.Scope, user identity.User, roles []string, rec approval.Record) approval.Record {
	return presentApprovals(s, ctx, scope, user, roles, []approval.Record{rec})[0]
}

// DecideCapability mirrors decide's order on the stored row: permission,
// status, self-approval, role, then targeting.
func DecideCapability(rec approval.Record, userID string, roles []string, targetsCaller bool) approval.DecideCapability {
	deny := func(code, reason string) approval.DecideCapability {
		return approval.DecideCapability{Allowed: false, Code: code, Reason: reason}
	}
	if !authz.Allows(authz.ExpandWorkspaceRoles(roles), authz.PermApprovalDecide) {
		return deny(approval.CapMissingPermission, "Your roles do not grant approval decisions.")
	}
	switch rec.Status {
	case approval.StatusPending:
	case approval.StatusCanceled:
		return deny(approval.CapApprovalClosed, "This approval is closed.")
	default:
		return deny(approval.CapNotPending, "This approval is not pending.")
	}
	if rec.RequestedBy != "" && rec.RequestedBy == userID {
		return deny(approval.CapSelfApproval, "The requester cannot decide their own request.")
	}
	if !approval.MayAct(roles, rec) {
		return deny(approval.CapRoleMismatch, "Your roles do not meet this gate's approver role.")
	}
	if !rec.Targeted() || targetsCaller {
		return approval.DecideCapability{Allowed: true, Via: approval.ViaTarget}
	}
	if isAdmin(roles) {
		return approval.DecideCapability{Allowed: true, Via: approval.ViaAdminOverride}
	}
	return deny(approval.CapApproverNotTargeted, "This gate names other approvers.")
}

func isAdmin(roles []string) bool {
	for _, r := range roles {
		if r == "admin" {
			return true
		}
	}
	return false
}

type principalNames struct {
	s           *core.Server
	ctx         context.Context
	workspaceID string
	users       map[string]string
	groups      map[string]string
}

func (p *principalNames) approvers(rec approval.Record) *approval.Approvers {
	out := &approval.Approvers{Users: []approval.PrincipalRef{}, Groups: []approval.PrincipalRef{}}
	for _, id := range rec.ApproverUserIDs {
		out.Users = append(out.Users, approval.PrincipalRef{ID: id, DisplayName: p.user(id)})
	}
	for _, id := range rec.ApproverGroupIDs {
		out.Groups = append(out.Groups, approval.PrincipalRef{ID: id, DisplayName: p.group(id)})
	}
	return out
}

func (p *principalNames) user(id string) string {
	if name, ok := p.users[id]; ok {
		return name
	}
	name := ""
	if p.s.Store != nil {
		if u, err := p.s.Store.GetUser(p.ctx, id); err == nil {
			name = u.DisplayName
		}
	}
	p.users[id] = name
	return name
}

func (p *principalNames) group(id string) string {
	if name, ok := p.groups[id]; ok {
		return name
	}
	name := ""
	if gs, ok := p.s.Store.(identity.GroupStore); ok {
		if g, err := gs.GetGroup(p.ctx, p.workspaceID, id); err == nil {
			name = g.DisplayName
		}
	}
	p.groups[id] = name
	return name
}
