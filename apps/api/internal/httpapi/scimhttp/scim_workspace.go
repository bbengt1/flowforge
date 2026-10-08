package scimhttp

import (
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
)

// Workspace-token SCIM. The token's workspace is the only workspace
// these handlers read or write, inside one workspace-scoped transaction
// per request. Users are visible only when this workspace's IdP linked
// them. Nothing here changes users.status, revokes a session, or edits
// a user's name: those fields are ignored and audited.

func scimActor(r *http.Request, scope scim.TokenScope) scim.Actor {
	return scim.Actor{RequestID: core.RequestIDFromContext(r.Context()), TokenID: scope.TokenID}
}

func wsListUsers(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	attr, value, start, count, err := scimPage(r)
	if err != nil || (attr != "" && attr != "userName" && attr != "externalId" && attr != "id") {
		writeSCIMError(w, http.StatusBadRequest, "The filter is not supported.")
		return
	}
	rows, total, err := s.ScimTokens.ListUsers(r.Context(), scope, attr, value, start, count)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	resources := make([]any, 0, len(rows))
	for _, u := range rows {
		resources = append(resources, scimWorkspaceUserResource(u))
	}
	writeSCIM(w, http.StatusOK, scimList(resources, start, count, total))
}

func wsPostUser(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseUserWrite(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	userName := ""
	if ch.UserName != nil {
		userName = strings.TrimSpace(*ch.UserName)
	}
	if userName == "" || len(userName) > 256 {
		writeSCIMError(w, http.StatusBadRequest, "userName is required.")
		return
	}
	ext := ""
	if ch.ExternalID != nil {
		ext = strings.TrimSpace(*ch.ExternalID)
	}
	if len(ext) > 256 || !authz.ValidSubject(scimSubject(userName, ext)) || !authz.ValidIssuer(s.SCIMSettings.Issuer) {
		writeSCIMError(w, http.StatusBadRequest, "The SCIM request is invalid.")
		return
	}
	display := userName
	if ch.DisplayName != nil && strings.TrimSpace(*ch.DisplayName) != "" {
		display = strings.TrimSpace(*ch.DisplayName)
	}
	if len(display) > 200 {
		writeSCIMError(w, http.StatusBadRequest, "The SCIM request is invalid.")
		return
	}
	active := true
	if ch.Active != nil {
		active = *ch.Active
	}
	u, err := s.ScimTokens.ProvisionUser(r.Context(), scope, scim.ProvisionInput{
		Issuer:      s.SCIMSettings.Issuer,
		Subject:     scimSubject(userName, ext),
		DisplayName: display,
		UserName:    userName,
		ExternalID:  ext,
		DefaultRole: s.SCIMSettings.DefaultRole,
		Active:      active,
	}, scimActor(r, scope), s.ClockNow())
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	w.Header().Set("Location", "/scim/v2/Users/"+u.UserID)
	writeSCIM(w, http.StatusCreated, scimWorkspaceUserResource(u))
}

func wsGetUser(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	u, err := s.ScimTokens.GetUser(r.Context(), scope, r.PathValue("id"))
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimWorkspaceUserResource(u))
}

func wsPutUser(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseUserWrite(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	if ch.UserName == nil || strings.TrimSpace(*ch.UserName) == "" {
		writeSCIMError(w, http.StatusBadRequest, "userName is required.")
		return
	}
	// PUT replaces the resource: an omitted active means true, the same
	// as the instance bearer.
	if ch.Active == nil {
		on := true
		ch.Active = &on
	}
	wsWriteUpdatedUser(s, w, r, scope, ch)
}

func wsPatchUser(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseUserPatch(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	wsWriteUpdatedUser(s, w, r, scope, ch)
}

func wsWriteUpdatedUser(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope, ch scim.UserChange) {
	u, err := s.ScimTokens.UpdateUser(r.Context(), scope, r.PathValue("id"), ch, s.SCIMSettings.DefaultRole, scimActor(r, scope), s.ClockNow())
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimWorkspaceUserResource(u))
}

func wsDeleteUser(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	if err := s.ScimTokens.RemoveUser(r.Context(), scope, r.PathValue("id"), scimActor(r, scope)); err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func wsListGroups(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	attr, value, start, count, err := scimPage(r)
	if err != nil || (attr != "" && attr != "displayName" && attr != "externalId" && attr != "id") {
		writeSCIMError(w, http.StatusBadRequest, "The filter is not supported.")
		return
	}
	g, err := s.ScimTokens.GetGroup(r.Context(), scope)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	match := false
	switch attr {
	case "":
		match = true
	case "displayName":
		match = strings.EqualFold(g.Name, value)
	case "externalId":
		match = g.WorkbenchKey == value
	case "id":
		match = g.ID == value
	}
	total := 0
	resources := []any{}
	if match {
		total = 1
		if count > 0 && start <= 1 {
			resources = append(resources, scimWorkspaceGroupResource(g))
		}
	}
	writeSCIM(w, http.StatusOK, scimList(resources, start, count, total))
}

func wsGetGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	if r.PathValue("id") != scope.WorkspaceID {
		writeSCIMError(w, http.StatusNotFound, "Resource not found.")
		return
	}
	g, err := s.ScimTokens.GetGroup(r.Context(), scope)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimWorkspaceGroupResource(g))
}

func wsPatchGroup(s *core.Server, w http.ResponseWriter, r *http.Request, scope scim.TokenScope) {
	if r.PathValue("id") != scope.WorkspaceID {
		writeSCIMError(w, http.StatusNotFound, "Resource not found.")
		return
	}
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseGroupPatch(raw)
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	g, err := s.ScimTokens.PatchGroup(r.Context(), scope, ch, s.SCIMSettings.DefaultRole, scimActor(r, scope), s.ClockNow())
	if err != nil {
		writeSCIMStoreError(s, w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimWorkspaceGroupResource(g))
}

func scimWorkspaceUserResource(u scim.WorkspaceUser) map[string]any {
	body := map[string]any{
		"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
		"id":          u.UserID,
		"userName":    u.UserName,
		"displayName": u.DisplayName,
		"active":      u.Active(),
		"name":        map[string]any{"formatted": u.DisplayName},
		"meta": map[string]any{
			"resourceType": "User",
			"created":      u.CreatedAt.UTC().Format(time.RFC3339),
			"lastModified": u.UpdatedAt.UTC().Format(time.RFC3339),
			"location":     "/scim/v2/Users/" + u.UserID,
		},
	}
	if u.ExternalID != "" {
		body["externalId"] = u.ExternalID
	}
	return body
}

func scimWorkspaceGroupResource(g scim.WorkspaceGroup) map[string]any {
	items := make([]any, 0, len(g.Members))
	for _, m := range g.Members {
		items = append(items, map[string]any{"value": m.UserID, "display": m.DisplayName})
	}
	return map[string]any{
		"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:Group"},
		"id":          g.ID,
		"displayName": g.Name,
		"externalId":  g.WorkbenchKey,
		"members":     items,
		"meta": map[string]any{
			"resourceType": "Group",
			"location":     "/scim/v2/Groups/" + g.ID,
		},
	}
}
