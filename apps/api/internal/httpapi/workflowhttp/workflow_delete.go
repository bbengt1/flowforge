package workflowhttp

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func deleteWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if RejectReservedWorkflowPath(s, w, r) {
		return
	}
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	if !requireWorkflowStore(s, w, r) {
		return
	}
	scope, perms, ok := s.PeekScopeGrants(w, r, user)
	if !ok {
		return
	}
	if !authz.Allows(perms, authz.PermWorkflowView) {
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	id := strings.TrimSpace(r.PathValue("workflowId"))
	wf, err := s.Workflows.Get(r.Context(), scope, id)
	if err != nil {
		if authz.Allows(perms, authz.PermWorkflowDelete) {
			if !s.ChargeWorkspace(w, r, scope.WorkspaceID()) {
				return
			}
		}
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if !canDeleteWorkflow(perms, scope.ActorID(), wf.CreatedBy) {
		core.WriteForbidden(w, r)
		return
	}
	if !s.ChargeWorkspace(w, r, scope.WorkspaceID()) {
		return
	}
	if _, err := s.Workflows.Delete(r.Context(), scope, id); err != nil {
		WriteWorkflowStoreError(w, r, err)
		return
	}
	if _, isMemory := s.Workflows.(*wfstore.Memory); isMemory {
		if s.Hooks != nil {
			if err := s.Hooks.DisableForWorkflow(r.Context(), scope, id); err != nil {
				core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
				return
			}
		}
		if s.Schedules != nil {
			if err := s.Schedules.DisableForWorkflow(r.Context(), scope, s.ClockNow(), id); err != nil {
				core.WriteProblem(w, r, http.StatusInternalServerError, core.CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
				return
			}
		}
	}
	w.WriteHeader(http.StatusNoContent)
}
