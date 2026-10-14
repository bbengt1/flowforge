package workspacehttp

import (
	"errors"
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

// Workspace error workflow admin routes (#649 S3).
//
// GET, PUT and DELETE /api/v1/workspace/error-workflow. The workspace
// comes from the session (like /workspace/cache); there is no path id.
// Door order: principal, embed refusal (before any grant is read),
// workspace.administer on the server-derived workspace, MFA step-up (PUT
// and DELETE only, the same mechanism and freshness window as the other
// privileged admin routes). There is no /embed/v1
// surface.

type putErrorWorkflowRequest struct {
	WorkflowID     string `json:"workflowId"`
	ID             string `json:"id"`
	WorkspaceID    string `json:"workspaceId"`
	WorkspaceIDAlt string `json:"workspace_id"`
}

func requireErrorWorkflowAdmin(s *core.Server, w http.ResponseWriter, r *http.Request, stepUp bool) (isolation.Scope, string, wfstore.ErrorWorkflowStore, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return isolation.Scope{}, "", nil, false
	}
	if pc := core.PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		core.WriteForbidden(w, r)
		return isolation.Scope{}, "", nil, false
	}
	ws, tenant, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return isolation.Scope{}, "", nil, false
	}
	if stepUp && !s.RequireMFAStepUp(w, r) {
		return isolation.Scope{}, "", nil, false
	}
	store, ok := s.Workflows.(wfstore.ErrorWorkflowStore)
	if s.Workflows == nil || !ok {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Service Unavailable", "The workflow store is not available.")
		return isolation.Scope{}, "", nil, false
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		core.WriteIdentityError(w, r, err)
		return isolation.Scope{}, "", nil, false
	}
	return scope, user.DisplayName, store, true
}

func errorWorkflowView(set wfstore.ErrorWorkflowSetting, ok bool) map[string]any {
	if !ok {
		return map[string]any{"errorWorkflow": nil}
	}
	return map[string]any{"errorWorkflow": map[string]any{
		"workflowId":   set.WorkflowID,
		"workflowName": set.WorkflowName,
		"workflowSlug": set.WorkflowSlug,
	}}
}

func errorWorkflowUnavailable(w http.ResponseWriter, r *http.Request) {
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Service Unavailable", "The workflow store is not available.")
}

func getErrorWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, _, store, ok := requireErrorWorkflowAdmin(s, w, r, false)
	if !ok {
		return
	}
	set, found, err := store.GetErrorWorkflow(r.Context(), scope)
	if err != nil {
		errorWorkflowUnavailable(w, r)
		return
	}
	core.WriteJSON(w, http.StatusOK, errorWorkflowView(set, found))
}

const errorWorkflowTargetDetail = "workflowId must be a published workflow in this workspace whose only trigger is error."

func putErrorWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, displayName, store, ok := requireErrorWorkflowAdmin(s, w, r, true)
	if !ok {
		return
	}
	var req putErrorWorkflowRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if core.HostIdentitySet(req.ID, req.WorkspaceID, req.WorkspaceIDAlt) {
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	set, err := store.SetErrorWorkflow(r.Context(), scope, req.WorkflowID, wfstore.AuditActor{
		DisplayName: displayName,
		RequestID:   core.RequestIDFromContext(r.Context()),
	})
	switch {
	case err == nil:
		core.WriteJSON(w, http.StatusOK, errorWorkflowView(set, true))
	case errors.Is(err, wfstore.ErrErrorWorkflowTarget):
		core.WriteProblemErrors(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", errorWorkflowTargetDetail, []core.FieldError{{
			Path: "workflowId", Code: core.CodeInvalidRequest, Message: errorWorkflowTargetDetail,
		}})
	default:
		errorWorkflowUnavailable(w, r)
	}
}

func deleteErrorWorkflow(s *core.Server, w http.ResponseWriter, r *http.Request) {
	scope, displayName, store, ok := requireErrorWorkflowAdmin(s, w, r, true)
	if !ok {
		return
	}
	if _, err := store.ClearErrorWorkflow(r.Context(), scope, wfstore.AuditActor{
		DisplayName: displayName,
		RequestID:   core.RequestIDFromContext(r.Context()),
	}); err != nil {
		errorWorkflowUnavailable(w, r)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
