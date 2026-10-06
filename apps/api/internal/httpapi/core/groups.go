package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

// requireGroupAdmin is the shared door for workspace group admin routes.
// Order: principal, embed refusal (before any grant is read), then
// workspace.administer on the server-derived workspace.
func (s *Server) requireGroupAdmin(w http.ResponseWriter, r *http.Request) (identity.User, identity.Workspace, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return identity.User{}, identity.Workspace{}, false
	}
	if pc := PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		WriteForbidden(w, r)
		return identity.User{}, identity.Workspace{}, false
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return identity.User{}, identity.Workspace{}, false
	}
	return user, ws, true
}

func (s *Server) groupsNotImplemented(w http.ResponseWriter, r *http.Request) {
	if _, _, ok := s.requireGroupAdmin(w, r); !ok {
		return
	}
	WriteProblem(w, r, http.StatusNotImplemented, CodeInternalError, "Not Implemented", "Workspace groups are not available yet.")
}

func (s *Server) listWorkspaceGroups(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}

func (s *Server) createWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}

func (s *Server) getWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}

func (s *Server) renameWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}

func (s *Server) deleteWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}

func (s *Server) addWorkspaceGroupMember(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}

func (s *Server) removeWorkspaceGroupMember(w http.ResponseWriter, r *http.Request) {
	s.groupsNotImplemented(w, r)
}
