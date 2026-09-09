package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const (
	headerIssuer       = "X-FlowForge-Issuer"
	headerSubject      = "X-FlowForge-Subject"
	headerDisplayName  = "X-FlowForge-Display-Name"
	headerTenantID     = "X-FlowForge-Tenant-ID"
	headerTenantSlug   = "X-FlowForge-Tenant-Slug"
	headerWorkbenchKey = "X-FlowForge-Workbench-Key"
	headerWorkspaceID  = "X-FlowForge-Workspace-ID"
)

type currentWorkspaceResponse struct {
	Workspace   identity.Workspace `json:"workspace"`
	Tenant      identity.Tenant    `json:"tenant"`
	Principal   identity.User      `json:"principal"`
	Roles       []string           `json:"roles"`
	Permissions []string           `json:"permissions"`
}

type listResponse[T any] struct {
	Items []T `json:"items"`
}

type permissionMatrixResponse struct {
	Permissions []authz.Permission `json:"permissions"`
	Roles       []authz.Role       `json:"roles"`
}

type createTenantRequest struct {
	Slug string `json:"slug"`
	Name string `json:"name"`
}

type createWorkspaceRequest struct {
	ID           string `json:"id"`
	WorkspaceID  string `json:"workspace_id"`
	TenantID     string `json:"tenant_id"`
	TenantSlug   string `json:"tenant_slug"`
	WorkbenchKey string `json:"workbench_key"`
	Name         string `json:"name"`
}

type setMemberRequest struct {
	ID              string   `json:"id"`
	WorkspaceID     string   `json:"workspace_id"`
	UserID          string   `json:"user_id"`
	Issuer          string   `json:"issuer"`
	ExternalSubject string   `json:"external_subject"`
	DisplayName     string   `json:"display_name"`
	RoleKeys        []string `json:"role_keys"`
}

func (s *Server) requireStore(w http.ResponseWriter, r *http.Request) bool {
	if s.store != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
	return false
}

func (s *Server) requireScopedStore(w http.ResponseWriter, r *http.Request) bool {
	if s.scoped != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Isolation store is not available.")
	return false
}

func (s *Server) requireScope(w http.ResponseWriter, r *http.Request, user identity.User, action string) (isolation.Scope, bool) {
	ws, tenant, _, _, ok := s.requireAccess(w, r, user, action)
	if !ok {
		return isolation.Scope{}, false
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		writeIdentityError(w, r, err)
		return isolation.Scope{}, false
	}
	return scope, true
}

func (s *Server) requirePrincipal(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	if !s.requireStore(w, r) {
		return identity.User{}, false
	}
	if token := sessionCookieValue(r); token != "" {
		return s.requireSessionPrincipal(w, r, token)
	}
	return s.requireHeaderPrincipal(w, r)
}

func claimedWorkspace(r *http.Request) authz.WorkspaceClaim {
	return authz.WorkspaceClaim{
		TenantID:        r.Header.Get(headerTenantID),
		TenantSlug:      r.Header.Get(headerTenantSlug),
		WorkbenchKey:    r.Header.Get(headerWorkbenchKey),
		HostWorkspaceID: r.Header.Get(headerWorkspaceID),
	}
}

func (s *Server) resolveWorkspace(w http.ResponseWriter, r *http.Request) (identity.Workspace, identity.Tenant, bool) {
	claim := claimedWorkspace(r)
	if pc := principalFromRequest(r); pc != nil && pc.session != nil && pc.session.Binding.Bound() {
		bound, err := embed.PropagateTenancy(embed.SessionTenancy{
			TenantID:     pc.session.Binding.TenantID,
			WorkbenchKey: pc.session.Binding.WorkbenchKey,
			WorkspaceID:  pc.session.Binding.WorkspaceID,
			Capabilities: pc.session.Binding.Capabilities,
		}, claim)
		if err != nil {
			writeEmbedError(w, r, err)
			return identity.Workspace{}, identity.Tenant{}, false
		}
		ws, tenant, err := s.store.ResolveWorkspace(r.Context(), bound.TenantID, "", bound.WorkbenchKey)
		if err != nil {
			writeIdentityError(w, r, err)
			return identity.Workspace{}, identity.Tenant{}, false
		}
		if bound.WorkspaceID != "" {
			if err := authz.ConfirmResolvedID(ws.ID, bound.WorkspaceID); err != nil {
				writeIdentityError(w, r, err)
				return identity.Workspace{}, identity.Tenant{}, false
			}
		}
		if err := authz.ConfirmResolvedID(ws.ID, claim.HostWorkspaceID); err != nil {
			writeIdentityError(w, r, err)
			return identity.Workspace{}, identity.Tenant{}, false
		}
		return ws, tenant, true
	}
	if err := authz.ValidateClaim(claim); err != nil {
		writeIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, false
	}
	ws, tenant, err := s.store.ResolveWorkspace(r.Context(), claim.Normalize().TenantID, claim.Normalize().TenantSlug, claim.Normalize().WorkbenchKey)
	if err != nil {
		writeIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, false
	}
	if err := authz.ConfirmResolvedID(ws.ID, claim.HostWorkspaceID); err != nil {
		writeIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, false
	}
	return ws, tenant, true
}

func (s *Server) requireAccess(w http.ResponseWriter, r *http.Request, user identity.User, action string) (identity.Workspace, identity.Tenant, []string, []string, bool) {
	ws, tenant, ok := s.resolveWorkspace(w, r)
	if !ok {
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	if ws.Status != "active" || tenant.Status != "active" {
		WriteForbidden(w, r)
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	roles, perms, err := s.store.EffectiveAccess(r.Context(), ws.ID, user.ID)
	if err != nil {
		writeIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	if pc := principalFromRequest(r); pc != nil && pc.session != nil && pc.session.Binding.Bound() {
		perms = embed.IntersectCapabilities(perms, pc.session.Binding.Capabilities)
	}
	if action == "" {
		if len(perms) == 0 {
			if pc := principalFromRequest(r); pc != nil && pc.session != nil {
				s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "no workspace membership")
			}
			WriteForbidden(w, r)
			return identity.Workspace{}, identity.Tenant{}, nil, nil, false
		}
		return ws, tenant, roles, perms, true
	}
	if !authz.Allows(perms, action) {
		if pc := principalFromRequest(r); pc != nil && pc.session != nil {
			s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing permission")
		}
		s.emitAuthorizationDenied(r, user, ws, action)
		WriteForbidden(w, r)
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	return ws, tenant, roles, perms, true
}

func (s *Server) getPermissionMatrix(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePrincipal(w, r); !ok {
		return
	}
	writeJSON(w, http.StatusOK, permissionMatrixResponse{
		Permissions: authz.Permissions(),
		Roles:       authz.Roles(),
	})
}

func (s *Server) getRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePrincipal(w, r); !ok {
		return
	}
	roles, err := s.store.ListRoles(r.Context())
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[identity.Role]{Items: roles})
}

func (s *Server) getPermissions(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePrincipal(w, r); !ok {
		return
	}
	perms, err := s.store.ListPermissions(r.Context())
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, listResponse[identity.Permission]{Items: perms})
}

func (s *Server) createTenant(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireBootstrapAdmin(w, r, user) {
		return
	}
	var req createTenantRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	tenant, err := s.store.CreateTenant(r.Context(), req.Slug, req.Name)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, tenant)
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	if !s.requireBootstrapAdmin(w, r, user) {
		return
	}
	var req createWorkspaceRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceID) != "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	tenantID := strings.TrimSpace(req.TenantID)
	if tenantID == "" {
		if strings.TrimSpace(req.TenantSlug) == "" {
			WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "tenant_id or tenant_slug is required.")
			return
		}
		tenant, err := s.store.GetTenantBySlug(r.Context(), strings.TrimSpace(req.TenantSlug))
		if err != nil {
			writeIdentityError(w, r, err)
			return
		}
		tenantID = tenant.ID
	}
	ws, err := s.store.CreateWorkspace(r.Context(), tenantID, req.WorkbenchKey, req.Name, user.ID)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, ws)
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	items, err := s.store.ListWorkspacesForUser(r.Context(), user.ID)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if items == nil {
		items = []identity.Membership{}
	}
	writeJSON(w, http.StatusOK, listResponse[identity.Membership]{Items: items})
}

func (s *Server) getCurrentWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	ws, tenant, roles, perms, ok := s.requireAccess(w, r, user, "")
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, currentWorkspaceResponse{
		Workspace:   ws,
		Tenant:      tenant,
		Principal:   user,
		Roles:       roles,
		Permissions: perms,
	})
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	ws, _, _, _, ok := s.requireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	items, err := s.store.ListMembers(r.Context(), ws.ID)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if items == nil {
		items = []identity.Member{}
	}
	writeJSON(w, http.StatusOK, listResponse[identity.Member]{Items: items})
}

func (s *Server) putMember(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	ws, _, _, _, ok := s.requireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	var req setMemberRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.ID) != "" || strings.TrimSpace(req.WorkspaceID) != "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Host-supplied workspace identity is not accepted.")
		return
	}
	target, err := s.store.ResolveUserRef(r.Context(), req.UserID, req.Issuer, req.ExternalSubject, req.DisplayName)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	if err := s.store.SetMemberRoles(r.Context(), ws.ID, target.ID, req.RoleKeys); err != nil {
		writeIdentityError(w, r, err)
		return
	}
	members, err := s.store.ListMembers(r.Context(), ws.ID)
	if err != nil {
		writeIdentityError(w, r, err)
		return
	}
	for _, m := range members {
		if m.User.ID == target.ID {
			writeJSON(w, http.StatusOK, m)
			return
		}
	}
	WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "Member could not be loaded after update.")
}

func (s *Server) deleteMember(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	ws, _, _, _, ok := s.requireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	targetID := strings.TrimSpace(r.PathValue("userID"))
	if targetID == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "userID is required.")
		return
	}
	if err := s.store.RemoveMember(r.Context(), ws.ID, targetID); err != nil {
		writeIdentityError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeIdentityError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, authz.ErrHostSuppliedWorkspaceID), errors.Is(err, authz.ErrIncompleteWorkspaceClaim), errors.Is(err, authz.ErrAmbiguousWorkspaceIdentity):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", err.Error()+".")
	case errors.Is(err, authz.ErrWorkspaceIdentityMismatch):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Host-supplied workspace identity does not match the server-derived workspace.")
	case errors.Is(err, identity.ErrNotFound):
		WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
	case errors.Is(err, identity.ErrConflict):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "A unique identity already exists.")
	case errors.Is(err, identity.ErrLastAdmin):
		WriteProblem(w, r, http.StatusConflict, CodeConflict, "Conflict", "Cannot remove the last workspace administrator.")
	case errors.Is(err, identity.ErrInvalid):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The request is not valid.")
	case errors.Is(err, identity.ErrDisabled):
		WriteForbidden(w, r)
	case errors.Is(err, identity.ErrStoreUnavailable):
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
	default:
		WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "An unexpected error occurred.")
	}
}
