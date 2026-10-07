package approvalhttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
)

// listApproverCandidates serves the builder picker. Contract only for
// now: it runs the principal, embed, and workflow.edit checks and then
// answers 501 until the store lands.
func listApproverCandidates(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if pc := core.PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		core.WriteForbidden(w, r)
		return
	}
	if _, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkflowEdit); !ok {
		return
	}
	core.WriteProblem(w, r, http.StatusNotImplemented, core.CodeInternalError, "Not Implemented", "Approver candidates are not available yet.")
}
