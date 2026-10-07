package core

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

// Workspace groups exist only to target approvals. These admin routes
// never grant a permission, and group membership never grants
// approval.decide. There is no /embed/v1 surface for groups.

type groupNameRequest struct {
	DisplayName string `json:"displayName"`
}

type groupMemberRequest struct {
	UserID string `json:"userId"`
}

const (
	groupNameTakenDetail   = "A group with this name already exists in the workspace."
	groupNameInvalidDetail = "displayName must be 1-128 characters after trimming and must not contain control characters."
	groupMemberDetail      = "The user is not an active member of this workspace."
	groupUserIDDetail      = "userId must be a UUID."
)

// requireGroupAdmin is the shared door for workspace group admin routes.
// Order: principal, embed refusal (before any grant, cap, or membership
// is read), store presence, then workspace.administer on the
// server-derived workspace.
func (s *Server) requireGroupAdmin(w http.ResponseWriter, r *http.Request) (identity.GroupStore, identity.User, identity.Workspace, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return nil, identity.User{}, identity.Workspace{}, false
	}
	if pc := PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		WriteForbidden(w, r)
		return nil, identity.User{}, identity.Workspace{}, false
	}
	groups, ok := s.Store.(identity.GroupStore)
	if !ok {
		WriteProblem(w, r, http.StatusServiceUnavailable, CodeDependencyUnavailable, "Dependency Unavailable", "Group store is not available.")
		return nil, identity.User{}, identity.Workspace{}, false
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return nil, identity.User{}, identity.Workspace{}, false
	}
	return groups, user, ws, true
}

// groupPathIDs reads path ids after the admin door. A {groupId} that is
// not a UUID is 404 not-found, the same as folders, workflows,
// credentials, approvals, and the identity proxy's uuid param match. A
// {userId} that is not a UUID is 400 invalid-request, the same as
// DELETE /workspace/members/{userID}. The stores repeat both checks so
// every backend answers the same.
func groupPathIDs(w http.ResponseWriter, r *http.Request, names ...string) ([]string, bool) {
	out := make([]string, 0, len(names))
	for _, name := range names {
		v := strings.TrimSpace(r.PathValue(name))
		if !authz.ValidUUID(v) {
			if name == "userId" {
				WriteProblemErrors(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", groupUserIDDetail, []FieldError{{
					Path: "userId", Code: CodeInvalidRequest, Message: groupUserIDDetail,
				}})
				return nil, false
			}
			WriteProblem(w, r, http.StatusNotFound, CodeNotFound, "Not Found", "The requested resource was not found.")
			return nil, false
		}
		out = append(out, v)
	}
	return out, true
}

func groupActor(r *http.Request, user identity.User) identity.GroupActor {
	return identity.GroupActor{UserID: user.ID, RequestID: RequestIDFromContext(r.Context())}
}

func (s *Server) listWorkspaceGroups(w http.ResponseWriter, r *http.Request) {
	groups, _, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	q, ok := ParsePage(w, r)
	if !ok {
		return
	}
	items, next, err := groups.ListGroupsPage(r.Context(), ws.ID, q)
	if RejectPageErr(w, r, err) {
		return
	}
	if err != nil {
		writeGroupError(w, r, err)
		return
	}
	WritePage(w, items, q, next)
}

func (s *Server) createWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	groups, user, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	var req groupNameRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	g, err := groups.CreateGroup(r.Context(), ws.ID, groupActor(r, user), req.DisplayName)
	if err != nil {
		writeGroupError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusCreated, g)
}

func (s *Server) getWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	groups, _, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	ids, ok := groupPathIDs(w, r, "groupId")
	if !ok {
		return
	}
	d, err := groups.GetGroup(r.Context(), ws.ID, ids[0])
	if err != nil {
		writeGroupError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, d)
}

func (s *Server) renameWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	groups, user, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	ids, ok := groupPathIDs(w, r, "groupId")
	if !ok {
		return
	}
	var req groupNameRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	g, err := groups.RenameGroup(r.Context(), ws.ID, groupActor(r, user), ids[0], req.DisplayName)
	if err != nil {
		writeGroupError(w, r, err)
		return
	}
	WriteJSON(w, http.StatusOK, g)
}

func (s *Server) deleteWorkspaceGroup(w http.ResponseWriter, r *http.Request) {
	groups, user, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	ids, ok := groupPathIDs(w, r, "groupId")
	if !ok {
		return
	}
	if err := groups.DeleteGroup(r.Context(), ws.ID, groupActor(r, user), ids[0]); err != nil {
		writeGroupError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) addWorkspaceGroupMember(w http.ResponseWriter, r *http.Request) {
	groups, user, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	ids, ok := groupPathIDs(w, r, "groupId")
	if !ok {
		return
	}
	var req groupMemberRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	userID := strings.TrimSpace(req.UserID)
	if !authz.ValidUUID(userID) {
		WriteProblemErrors(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", groupUserIDDetail, []FieldError{{
			Path: "userId", Code: CodeInvalidRequest, Message: groupUserIDDetail,
		}})
		return
	}
	if err := groups.AddGroupMember(r.Context(), ws.ID, groupActor(r, user), ids[0], userID); err != nil {
		writeGroupError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) removeWorkspaceGroupMember(w http.ResponseWriter, r *http.Request) {
	groups, user, ws, ok := s.requireGroupAdmin(w, r)
	if !ok {
		return
	}
	ids, ok := groupPathIDs(w, r, "groupId", "userId")
	if !ok {
		return
	}
	if err := groups.RemoveGroupMember(r.Context(), ws.ID, groupActor(r, user), ids[0], ids[1]); err != nil {
		writeGroupError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeGroupError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, identity.ErrGroupNameTaken):
		WriteProblemErrors(w, r, http.StatusConflict, CodeGroupNameTaken, "Conflict", groupNameTakenDetail, []FieldError{{
			Path: "displayName", Code: CodeGroupNameTaken, Message: groupNameTakenDetail,
		}})
	case errors.Is(err, identity.ErrGroupNameInvalid):
		WriteProblemErrors(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", groupNameInvalidDetail, []FieldError{{
			Path: "displayName", Code: CodeInvalidRequest, Message: groupNameInvalidDetail,
		}})
	case errors.Is(err, identity.ErrGroupMemberNotInWorkspace):
		WriteProblemErrors(w, r, http.StatusBadRequest, CodeGroupMemberNotInWorkspace, "Invalid Request", groupMemberDetail, []FieldError{{
			Path: "userId", Code: CodeGroupMemberNotInWorkspace, Message: groupMemberDetail,
		}})
	default:
		WriteIdentityError(w, r, err)
	}
}
