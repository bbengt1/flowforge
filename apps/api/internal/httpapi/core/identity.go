package core

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const (
	HeaderIssuer       = "X-FlowForge-Issuer"
	HeaderSubject      = "X-FlowForge-Subject"
	HeaderDisplayName  = "X-FlowForge-Display-Name"
	HeaderTenantID     = "X-FlowForge-Tenant-ID"
	HeaderTenantSlug   = "X-FlowForge-Tenant-Slug"
	HeaderWorkbenchKey = "X-FlowForge-Workbench-Key"
	HeaderWorkspaceID  = "X-FlowForge-Workspace-ID"
	HeaderHostIssuer   = embed.HeaderHostIssuer
	HeaderHostContext  = embed.HeaderHostContext
)

type CurrentWorkspaceResponse struct {
	Workspace   identity.Workspace `json:"workspace"`
	Tenant      identity.Tenant    `json:"tenant"`
	Principal   identity.User      `json:"principal"`
	Roles       []string           `json:"roles"`
	Permissions []string           `json:"permissions"`
}

type ListResponse[T any] struct {
	Items []T `json:"items"`
}

type PermissionMatrixResponse struct {
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

func (s *Server) RequireStore(w http.ResponseWriter, r *http.Request) bool {
	if s.Store != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Identity store is not available.")
	return false
}

func (s *Server) RequireScopedStore(w http.ResponseWriter, r *http.Request) bool {
	if s.Scoped != nil {
		return true
	}
	WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Isolation store is not available.")
	return false
}

func (s *Server) RequireScope(w http.ResponseWriter, r *http.Request, user identity.User, action string) (isolation.Scope, bool) {
	ws, tenant, _, _, ok := s.RequireAccess(w, r, user, action)
	if !ok {
		return isolation.Scope{}, false
	}
	scope, err := isolation.AuthorizeTenancy(ws.ID, user.ID, tenant.ID, ws.WorkbenchKey)
	if err != nil {
		WriteIdentityError(w, r, err)
		return isolation.Scope{}, false
	}
	return scope, true
}

func (s *Server) RequirePrincipal(w http.ResponseWriter, r *http.Request) (identity.User, bool) {
	if !s.RequireStore(w, r) {
		return identity.User{}, false
	}
	if token := SessionCookieValue(r); token != "" {
		return s.RequireSessionPrincipal(w, r, token)
	}
	if token := bearerSessionToken(r); token != "" {
		return s.RequireSessionPrincipal(w, r, token)
	}
	return s.requireHeaderPrincipal(w, r)
}

func claimedWorkspace(r *http.Request) authz.WorkspaceClaim {
	return authz.WorkspaceClaim{
		TenantID:        r.Header.Get(HeaderTenantID),
		TenantSlug:      r.Header.Get(HeaderTenantSlug),
		WorkbenchKey:    r.Header.Get(HeaderWorkbenchKey),
		HostWorkspaceID: r.Header.Get(HeaderWorkspaceID),
	}
}

func (s *Server) resolveWorkspace(w http.ResponseWriter, r *http.Request) (identity.Workspace, identity.Tenant, bool) {
	claim := claimedWorkspace(r)
	if pc := PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		bound, err := embed.PropagateTenancy(embed.SessionTenancy{
			TenantID:     pc.Session.Binding.TenantID,
			WorkbenchKey: pc.Session.Binding.WorkbenchKey,
			WorkspaceID:  pc.Session.Binding.WorkspaceID,
			Capabilities: pc.Session.Binding.Capabilities,
		}, claim)
		if err != nil {
			s.AuditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonTenancy, "", "", pc.User.Issuer, pc.User.ExternalSubject)
			WriteEmbedError(w, r, err)
			return identity.Workspace{}, identity.Tenant{}, false
		}
		ws, tenant, err := s.Store.ResolveWorkspace(r.Context(), bound.TenantID, "", bound.WorkbenchKey)
		if err != nil {
			WriteIdentityError(w, r, err)
			return identity.Workspace{}, identity.Tenant{}, false
		}
		if bound.WorkspaceID != "" {
			if err := authz.ConfirmResolvedID(ws.ID, bound.WorkspaceID); err != nil {
				WriteIdentityError(w, r, err)
				return identity.Workspace{}, identity.Tenant{}, false
			}
		}
		if err := authz.ConfirmResolvedID(ws.ID, claim.HostWorkspaceID); err != nil {
			WriteIdentityError(w, r, err)
			return identity.Workspace{}, identity.Tenant{}, false
		}
		return ws, tenant, true
	}
	if err := authz.ValidateClaim(claim); err != nil {
		WriteIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, false
	}
	ws, tenant, err := s.Store.ResolveWorkspace(r.Context(), claim.Normalize().TenantID, claim.Normalize().TenantSlug, claim.Normalize().WorkbenchKey)
	if err != nil {
		WriteIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, false
	}
	if err := authz.ConfirmResolvedID(ws.ID, claim.HostWorkspaceID); err != nil {
		WriteIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, false
	}
	return ws, tenant, true
}

func (s *Server) RequireAccess(w http.ResponseWriter, r *http.Request, user identity.User, action string) (identity.Workspace, identity.Tenant, []string, []string, bool) {
	ws, tenant, ok := s.resolveWorkspace(w, r)
	if !ok {
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	if ws.Status != "active" || tenant.Status != "active" {
		WriteForbidden(w, r)
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	roles, perms, err := s.Store.EffectiveAccess(r.Context(), ws.ID, user.ID)
	if err != nil {
		WriteIdentityError(w, r, err)
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	perms, err = s.unionMachinePerms(r, user, ws, perms)
	if err != nil {
		if errors.Is(err, machine.ErrRevoked) || errors.Is(err, machine.ErrWorkspace) {
			WriteForbidden(w, r)
			return identity.Workspace{}, identity.Tenant{}, nil, nil, false
		}
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Machine principal store is not available.")
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	if pc := PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		perms = embed.IntersectCapabilities(perms, pc.Session.Binding.Capabilities)
	}
	if action == "" {
		if len(perms) == 0 {
			if pc := PrincipalFromRequest(r); pc != nil && pc.Session != nil {
				s.AuditSession(r, *pc.Session, session.EventPrivilegeDenied, session.OutcomeDenied, "no workspace membership")
				if pc.Session.Binding.Bound() {
					s.AuditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonCapability, "", "", user.Issuer, user.ExternalSubject)
				}
			}
			WriteForbidden(w, r)
			return identity.Workspace{}, identity.Tenant{}, nil, nil, false
		}
		if !s.chargeQuota(w, r, ws.ID) {
			return identity.Workspace{}, identity.Tenant{}, nil, nil, false
		}
		return ws, tenant, roles, perms, true
	}
	if !authz.Allows(perms, action) {
		if pc := PrincipalFromRequest(r); pc != nil && pc.Session != nil {
			s.AuditSession(r, *pc.Session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing permission")
			if pc.Session.Binding.Bound() {
				s.AuditEmbed(r, embed.EventRejected, session.OutcomeDenied, embed.ReasonCapability, "", "", user.Issuer, user.ExternalSubject)
			}
		}
		s.emitAuthorizationDenied(r, user, ws, action)
		WriteForbidden(w, r)
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	if !s.allowMFAGrant(w, r, action) {
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	if !s.chargeQuota(w, r, ws.ID) {
		return identity.Workspace{}, identity.Tenant{}, nil, nil, false
	}
	return ws, tenant, roles, perms, true
}

func (s *Server) getPermissionMatrix(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.RequirePrincipal(w, r); !ok {
		return
	}
	WriteJSON(w, http.StatusOK, PermissionMatrixResponse{
		Permissions: authz.Permissions(),
		Roles:       authz.Roles(),
	})
}

func (s *Server) getRoles(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.RequirePrincipal(w, r); !ok {
		return
	}
	roles, err := s.Store.ListRoles(r.Context())
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, ListResponse[identity.Role]{Items: roles})
}

func (s *Server) getPermissions(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.RequirePrincipal(w, r); !ok {
		return
	}
	perms, err := s.Store.ListPermissions(r.Context())
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, ListResponse[identity.Permission]{Items: perms})
}

func (s *Server) createTenant(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
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
	tenant, err := s.Store.CreateTenant(r.Context(), req.Slug, req.Name)
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusCreated, tenant)
}

func (s *Server) createWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
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
		tenant, err := s.Store.GetTenantBySlug(r.Context(), strings.TrimSpace(req.TenantSlug))
		if err != nil {
			WriteIdentityError(w, r, err)
			return
		}
		tenantID = tenant.ID
	}
	ws, err := s.Store.CreateWorkspace(r.Context(), tenantID, req.WorkbenchKey, req.Name, user.ID)
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusCreated, ws)
}

func (s *Server) deleteWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	// Fail closed: do not disable the workspace if bound sessions cannot
	// be revoked. A later disable-after-revoke failure leaves sessions
	// revoked (safe); the inverse is not.
	if !s.RequireSessions(w, r) {
		return
	}
	ws, tenant, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	revoked, err := s.Sessions.RevokeBoundToWorkspace(r.Context(), ws.ID, tenant.ID, ws.WorkbenchKey, s.ClockNow())
	if err != nil {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Bound sessions could not be revoked; the workspace was not deleted.")
		return
	}
	for _, rec := range revoked {
		s.AuditSession(r, rec, session.EventRevoked, session.OutcomeAllowed, "workspace deleted")
	}
	if _, err := s.Store.DeleteWorkspace(r.Context(), ws.ID); err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listWorkspaces(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	q, ok := ParsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.Store.ListWorkspacesForUserPage(r.Context(), user.ID, q)
	if RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	WritePage(w, items, q, next)
}

func (s *Server) getCurrentWorkspace(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	ws, tenant, roles, perms, ok := s.RequireAccess(w, r, user, "")
	if !ok {
		return
	}
	WriteJSON(w, http.StatusOK, CurrentWorkspaceResponse{
		Workspace:   ws,
		Tenant:      tenant,
		Principal:   user,
		Roles:       roles,
		Permissions: perms,
	})
}

func (s *Server) listMembers(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	q, ok := ParsePage(w, r)
	if !ok {
		return
	}
	items, next, err := s.Store.ListMembersPage(r.Context(), ws.ID, q)
	if RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	WritePage(w, items, q, next)
}

func (s *Server) PutMember(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
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
	target, err := s.Store.ResolveUserRef(r.Context(), req.UserID, req.Issuer, req.ExternalSubject, req.DisplayName)
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	if err := s.Store.SetMemberRoles(r.Context(), ws.ID, target.ID, req.RoleKeys); err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	members, err := s.Store.ListMembers(r.Context(), ws.ID)
	if err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	for _, m := range members {
		if m.User.ID == target.ID {
			WriteJSON(w, http.StatusOK, m)
			return
		}
	}
	WriteProblem(w, r, http.StatusInternalServerError, CodeInternalError, "Internal Server Error", "Member could not be loaded after update.")
}

func (s *Server) deleteMember(w http.ResponseWriter, r *http.Request) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return
	}
	targetID := strings.TrimSpace(r.PathValue("userID"))
	if targetID == "" {
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "userID is required.")
		return
	}
	if err := s.Store.RemoveMember(r.Context(), ws.ID, targetID); err != nil {
		WriteIdentityError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func WriteIdentityError(w http.ResponseWriter, r *http.Request, err error) {
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
