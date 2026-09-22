package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const scimMediaType = "application/scim+json"

// SCIM 2.0 (/scim/v2) is a dedicated bearer door. It is not local login,
// not OIDC, not a machine principal, and not embed exchange. The bearer
// is never written to the response or the log. Users map onto the
// existing identity row (issuer + external subject). Groups are
// workspaces; member changes use workspace role bindings.

func (s *Server) authorizeSCIM(w http.ResponseWriter, r *http.Request) bool {
	if !s.scimSettings.Ready() || s.scimDir == nil {
		writeSCIMError(w, http.StatusServiceUnavailable, "SCIM is not configured.")
		return false
	}
	if !scimQueryAllowed(r) {
		writeSCIMError(w, http.StatusUnauthorized, "Authentication is required.")
		return false
	}
	token, ok := presentedBearer(r)
	if !ok || !s.scimSettings.Match(token) {
		writeSCIMError(w, http.StatusUnauthorized, "Authentication is required.")
		return false
	}
	return true
}

func (s *Server) scimReady(w http.ResponseWriter) bool {
	if s.store == nil || s.sessions == nil || s.scimDir == nil {
		writeSCIMError(w, http.StatusServiceUnavailable, "The directory is not available.")
		return false
	}
	return true
}

func (s *Server) getSCIMServiceProviderConfig(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) {
		return
	}
	writeSCIM(w, http.StatusOK, map[string]any{
		"schemas":          []string{"urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"},
		"documentationUri": "https://github.com/bbengt1/flowforge/blob/main/docs/reference/security-model.md",
		"patch":            map[string]any{"supported": true},
		"bulk":             map[string]any{"supported": false, "maxOperations": 0, "maxPayloadSize": 0},
		"filter":           map[string]any{"supported": true, "maxResults": 100},
		"changePassword":   map[string]any{"supported": false},
		"sort":             map[string]any{"supported": false},
		"etag":             map[string]any{"supported": false},
		"authenticationSchemes": []any{map[string]any{
			"type":        "oauthbearertoken",
			"name":        "SCIM Bearer",
			"description": "Dedicated SCIM bearer. Not a session, machine principal, or embed token.",
			"primary":     true,
		}},
	})
}

func (s *Server) getSCIMResourceTypes(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) {
		return
	}
	writeSCIM(w, http.StatusOK, scimList([]any{
		map[string]any{
			"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"},
			"id":          "User",
			"name":        "User",
			"endpoint":    "/scim/v2/Users",
			"schema":      "urn:ietf:params:scim:schemas:core:2.0:User",
			"description": "FlowForge user. id is users.id. externalId maps to external_subject when set.",
		},
		map[string]any{
			"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:ResourceType"},
			"id":          "Group",
			"name":        "Group",
			"endpoint":    "/scim/v2/Groups",
			"schema":      "urn:ietf:params:scim:schemas:core:2.0:Group",
			"description": "Workspace membership. id is the workspace id. Creating a group is not supported.",
		},
	}, 1, 2, 2))
}

func (s *Server) getSCIMSchemas(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) {
		return
	}
	writeSCIM(w, http.StatusOK, scimList([]any{
		map[string]any{
			"id":          "urn:ietf:params:scim:schemas:core:2.0:User",
			"name":        "User",
			"description": "userName, externalId, displayName, name.formatted, and active. Passwords are rejected.",
		},
		map[string]any{
			"id":          "urn:ietf:params:scim:schemas:core:2.0:Group",
			"name":        "Group",
			"description": "Workspace display name and members. Members receive the configured workspace role.",
		},
	}, 1, 2, 2))
}

func (s *Server) listSCIMUsers(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	attr, value, start, count, err := scimPage(r)
	if err != nil || (attr != "" && attr != "userName" && attr != "externalId" && attr != "id") {
		writeSCIMError(w, http.StatusBadRequest, "The filter is not supported.")
		return
	}
	rows, total, err := s.scimDir.List(r.Context(), attr, value, start, count)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	resources := make([]any, 0, len(rows))
	for _, rec := range rows {
		user, err := s.store.GetUser(r.Context(), rec.UserID)
		if err != nil {
			s.writeSCIMStoreError(w, err)
			return
		}
		resources = append(resources, scimUserResource(user, rec))
	}
	writeSCIM(w, http.StatusOK, scimList(resources, start, count, total))
}

func (s *Server) postSCIMUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseUserWrite(raw)
	if err != nil {
		s.writeSCIMStoreError(w, err)
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
	if len(ext) > 256 || !authz.ValidSubject(scimSubject(userName, ext)) || !authz.ValidIssuer(s.scimSettings.Issuer) {
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
	if rec, err := s.scimDir.FindByUserName(r.Context(), userName); err == nil && rec.Active() {
		writeSCIMError(w, http.StatusConflict, "That resource already exists.")
		return
	} else if err != nil && !errors.Is(err, scim.ErrNotFound) {
		s.writeSCIMStoreError(w, err)
		return
	}
	if ext != "" {
		if rec, err := s.scimDir.FindByExternalID(r.Context(), ext); err == nil && rec.Active() {
			writeSCIMError(w, http.StatusConflict, "That resource already exists.")
			return
		} else if err != nil && !errors.Is(err, scim.ErrNotFound) {
			s.writeSCIMStoreError(w, err)
			return
		}
	}
	user, err := s.store.UpsertUser(r.Context(), s.scimSettings.Issuer, scimSubject(userName, ext), display)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	if existing, err := s.scimDir.Get(r.Context(), user.ID); err == nil && existing.Active() {
		writeSCIMError(w, http.StatusConflict, "That resource already exists.")
		return
	} else if err != nil && !errors.Is(err, scim.ErrNotFound) {
		s.writeSCIMStoreError(w, err)
		return
	}
	now := s.clockNow()
	rec := scim.Record{
		UserID:     user.ID,
		UserName:   userName,
		ExternalID: ext,
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if err := s.scimDir.Save(r.Context(), rec); err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	if active {
		if err := s.store.SetUserStatus(r.Context(), user.ID, "active"); err != nil {
			s.writeSCIMStoreError(w, err)
			return
		}
	} else if err := s.disableSCIMUser(r.Context(), user.ID, now); err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	user, err = s.store.GetUser(r.Context(), user.ID)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	w.Header().Set("Location", "/scim/v2/Users/"+user.ID)
	writeSCIM(w, http.StatusCreated, scimUserResource(user, rec))
}

func (s *Server) getSCIMUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	user, rec, err := s.loadActiveSCIMUser(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimUserResource(user, rec))
}

func (s *Server) putSCIMUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseUserWrite(raw)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	if ch.UserName == nil || strings.TrimSpace(*ch.UserName) == "" {
		writeSCIMError(w, http.StatusBadRequest, "userName is required.")
		return
	}
	if ch.Active == nil {
		on := true
		ch.Active = &on
	}
	s.writeMutatedUser(w, r, ch)
}

func (s *Server) patchSCIMUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseUserPatch(raw)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	s.writeMutatedUser(w, r, ch)
}

func (s *Server) writeMutatedUser(w http.ResponseWriter, r *http.Request, ch scim.UserChange) {
	user, rec, err := s.loadActiveSCIMUser(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	user, rec, err = s.mutateSCIMUser(r.Context(), user, rec, ch)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	writeSCIM(w, http.StatusOK, scimUserResource(user, rec))
}

func (s *Server) deleteSCIMUser(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	_, rec, err := s.loadActiveSCIMUser(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	now := s.clockNow()
	if err := s.disableSCIMUser(r.Context(), rec.UserID, now); err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	rec.DeprovisionedAt = &now
	rec.UpdatedAt = now
	if err := s.scimDir.Save(r.Context(), rec); err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSCIMGroups(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	attr, value, start, count, err := scimPage(r)
	if err != nil || (attr != "" && attr != "displayName" && attr != "externalId" && attr != "id") {
		writeSCIMError(w, http.StatusBadRequest, "The filter is not supported.")
		return
	}
	workspaces, err := s.store.ListActiveWorkspaces(r.Context())
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	var matched []identity.Workspace
	for _, ws := range workspaces {
		if scimGroupMatch(ws, attr, value) {
			matched = append(matched, ws)
		}
	}
	total := len(matched)
	var page []identity.Workspace
	if count > 0 && start <= total {
		offset := start - 1
		end := offset + count
		if end > total {
			end = total
		}
		page = matched[offset:end]
	}
	resources := make([]any, 0, len(page))
	for _, ws := range page {
		body, err := s.scimGroupResource(r.Context(), ws)
		if err != nil {
			s.writeSCIMStoreError(w, err)
			return
		}
		resources = append(resources, body)
	}
	writeSCIM(w, http.StatusOK, scimList(resources, start, count, total))
}

func (s *Server) postSCIMGroup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) {
		return
	}
	writeSCIMError(w, http.StatusBadRequest, "Groups are existing workspaces.")
}

func (s *Server) putSCIMGroup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) {
		return
	}
	writeSCIMError(w, http.StatusBadRequest, "Groups are existing workspaces. Patch members to change membership.")
}

func (s *Server) deleteSCIMGroup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) {
		return
	}
	writeSCIMError(w, http.StatusBadRequest, "Groups are existing workspaces and cannot be deleted here.")
}

func (s *Server) getSCIMGroup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	ws, err := s.loadSCIMGroup(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	body, err := s.scimGroupResource(r.Context(), ws)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	writeSCIM(w, http.StatusOK, body)
}

func (s *Server) patchSCIMGroup(w http.ResponseWriter, r *http.Request) {
	if !s.authorizeSCIM(w, r) || !s.scimReady(w) {
		return
	}
	raw, ok := decodeSCIM(w, r)
	if !ok {
		return
	}
	ch, err := scim.ParseGroupPatch(raw)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	ws, err := s.loadSCIMGroup(r.Context(), r.PathValue("id"))
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	for _, id := range ch.Add {
		if err := s.addSCIMMember(r.Context(), ws.ID, id); err != nil {
			s.writeSCIMStoreError(w, err)
			return
		}
	}
	for _, id := range ch.Remove {
		err := s.store.RemoveMember(r.Context(), ws.ID, id)
		if err == nil || errors.Is(err, identity.ErrNotFound) {
			continue
		}
		s.writeSCIMStoreError(w, err)
		return
	}
	body, err := s.scimGroupResource(r.Context(), ws)
	if err != nil {
		s.writeSCIMStoreError(w, err)
		return
	}
	writeSCIM(w, http.StatusOK, body)
}

func (s *Server) loadActiveSCIMUser(ctx context.Context, id string) (identity.User, scim.Record, error) {
	rec, err := s.scimDir.Get(ctx, id)
	if err != nil {
		return identity.User{}, scim.Record{}, err
	}
	if !rec.Active() {
		return identity.User{}, scim.Record{}, scim.ErrNotFound
	}
	user, err := s.store.GetUser(ctx, rec.UserID)
	if err != nil {
		return identity.User{}, scim.Record{}, err
	}
	return user, rec, nil
}

func (s *Server) mutateSCIMUser(ctx context.Context, user identity.User, rec scim.Record, ch scim.UserChange) (identity.User, scim.Record, error) {
	userName := rec.UserName
	if ch.UserName != nil {
		userName = strings.TrimSpace(*ch.UserName)
		if userName == "" || len(userName) > 256 {
			return identity.User{}, scim.Record{}, scim.ErrInvalid
		}
	}
	ext := rec.ExternalID
	if ch.ExternalID != nil {
		ext = strings.TrimSpace(*ch.ExternalID)
		if len(ext) > 256 {
			return identity.User{}, scim.Record{}, scim.ErrInvalid
		}
	}
	subject := scimSubject(userName, ext)
	if subject != user.ExternalSubject || !authz.ValidSubject(subject) {
		return identity.User{}, scim.Record{}, scim.ErrInvalid
	}
	if !strings.EqualFold(userName, rec.UserName) {
		other, err := s.scimDir.FindByUserName(ctx, userName)
		if err != nil && !errors.Is(err, scim.ErrNotFound) {
			return identity.User{}, scim.Record{}, err
		}
		if err == nil && other.Active() && other.UserID != user.ID {
			return identity.User{}, scim.Record{}, scim.ErrConflict
		}
	}
	display := user.DisplayName
	if ch.DisplayName != nil {
		display = strings.TrimSpace(*ch.DisplayName)
	}
	if len(display) > 200 {
		return identity.User{}, scim.Record{}, scim.ErrInvalid
	}
	if display != user.DisplayName {
		updated, err := s.store.UpsertUser(ctx, user.Issuer, user.ExternalSubject, display)
		if err != nil {
			return identity.User{}, scim.Record{}, err
		}
		user = updated
	}
	now := s.clockNow()
	rec.UserName = userName
	rec.ExternalID = ext
	rec.UpdatedAt = now
	rec.DeprovisionedAt = nil
	if err := s.scimDir.Save(ctx, rec); err != nil {
		return identity.User{}, scim.Record{}, err
	}
	if ch.Active != nil {
		if *ch.Active {
			if err := s.store.SetUserStatus(ctx, user.ID, "active"); err != nil {
				return identity.User{}, scim.Record{}, err
			}
		} else if err := s.disableSCIMUser(ctx, user.ID, now); err != nil {
			return identity.User{}, scim.Record{}, err
		}
		reloaded, err := s.store.GetUser(ctx, user.ID)
		if err != nil {
			return identity.User{}, scim.Record{}, err
		}
		user = reloaded
	}
	return user, rec, nil
}

func (s *Server) disableSCIMUser(ctx context.Context, userID string, now time.Time) error {
	if err := s.store.SetUserStatus(ctx, userID, "disabled"); err != nil {
		return err
	}
	if s.sessions == nil {
		return session.ErrStoreUnavailable
	}
	if err := s.sessions.RevokeByUser(ctx, userID, now); err != nil {
		return err
	}
	memberships, err := s.store.ListWorkspacesForUser(ctx, userID)
	if err != nil {
		return err
	}
	for _, membership := range memberships {
		err := s.store.RemoveMember(ctx, membership.Workspace.ID, userID)
		if err == nil || errors.Is(err, identity.ErrNotFound) || errors.Is(err, identity.ErrLastAdmin) {
			continue
		}
		return err
	}
	return nil
}

func (s *Server) loadSCIMGroup(ctx context.Context, id string) (identity.Workspace, error) {
	ws, err := s.store.GetWorkspace(ctx, id)
	if err != nil {
		return identity.Workspace{}, err
	}
	if !strings.EqualFold(ws.Status, "active") {
		return identity.Workspace{}, scim.ErrNotFound
	}
	tenant, err := s.store.GetTenant(ctx, ws.TenantID)
	if err != nil {
		return identity.Workspace{}, err
	}
	if !strings.EqualFold(tenant.Status, "active") {
		return identity.Workspace{}, scim.ErrNotFound
	}
	return ws, nil
}

func (s *Server) addSCIMMember(ctx context.Context, workspaceID, userID string) error {
	user, err := s.store.GetUser(ctx, userID)
	if err != nil {
		if errors.Is(err, identity.ErrInvalid) || errors.Is(err, identity.ErrNotFound) {
			return scim.ErrInvalid
		}
		return err
	}
	if user.Status != "active" {
		return scim.ErrInvalid
	}
	roles, _, err := s.store.EffectiveAccess(ctx, workspaceID, userID)
	if err != nil && !errors.Is(err, identity.ErrNotFound) {
		return err
	}
	if errors.Is(err, identity.ErrNotFound) {
		roles = nil
	}
	role := s.scimSettings.DefaultRole
	if role == "" {
		role = scim.DefaultRole
	}
	if !slicesContains(roles, role) {
		roles = append(roles, role)
	}
	return s.store.SetMemberRoles(ctx, workspaceID, userID, roles)
}

func (s *Server) scimGroupResource(ctx context.Context, ws identity.Workspace) (map[string]any, error) {
	members, err := s.store.ListMembers(ctx, ws.ID)
	if err != nil {
		return nil, err
	}
	items := make([]any, 0, len(members))
	for _, member := range members {
		items = append(items, map[string]any{
			"value":   member.User.ID,
			"display": member.User.DisplayName,
		})
	}
	return map[string]any{
		"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:Group"},
		"id":          ws.ID,
		"displayName": ws.Name,
		"externalId":  ws.WorkbenchKey,
		"members":     items,
		"meta": map[string]any{
			"resourceType": "Group",
			"location":     "/scim/v2/Groups/" + ws.ID,
		},
	}, nil
}

func scimGroupMatch(ws identity.Workspace, attr, value string) bool {
	switch attr {
	case "":
		return true
	case "displayName":
		return strings.EqualFold(ws.Name, value)
	case "externalId":
		return ws.WorkbenchKey == value
	case "id":
		return ws.ID == value
	default:
		return false
	}
}

func scimUserResource(user identity.User, rec scim.Record) map[string]any {
	body := map[string]any{
		"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
		"id":          user.ID,
		"userName":    rec.UserName,
		"displayName": user.DisplayName,
		"active":      user.Status == "active" && rec.Active(),
		"name":        map[string]any{"formatted": user.DisplayName},
		"meta": map[string]any{
			"resourceType": "User",
			"created":      rec.CreatedAt.UTC().Format(time.RFC3339),
			"lastModified": rec.UpdatedAt.UTC().Format(time.RFC3339),
			"location":     "/scim/v2/Users/" + user.ID,
		},
	}
	if rec.ExternalID != "" {
		body["externalId"] = rec.ExternalID
	}
	return body
}

func scimList(resources []any, start, count, total int) map[string]any {
	if resources == nil {
		resources = []any{}
	}
	shown := len(resources)
	if count == 0 {
		shown = 0
	}
	return map[string]any{
		"schemas":      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"totalResults": total,
		"startIndex":   start,
		"itemsPerPage": shown,
		"Resources":    resources,
	}
}

func scimSubject(userName, externalID string) string {
	if strings.TrimSpace(externalID) != "" {
		return strings.TrimSpace(externalID)
	}
	return strings.TrimSpace(userName)
}

func slicesContains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func writeSCIM(w http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(w, "failed to encode response", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", scimMediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func writeSCIMError(w http.ResponseWriter, status int, detail string) {
	if status == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", "Bearer")
	}
	writeSCIM(w, status, map[string]any{
		"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:Error"},
		"status":  strconv.Itoa(status),
		"detail":  detail,
	})
}

func (s *Server) writeSCIMStoreError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, scim.ErrSecret):
		writeSCIMError(w, http.StatusBadRequest, "Passwords and secrets are not accepted.")
	case errors.Is(err, scim.ErrInvalid), errors.Is(err, identity.ErrInvalid):
		writeSCIMError(w, http.StatusBadRequest, "The SCIM request is invalid.")
	case errors.Is(err, scim.ErrNotFound), errors.Is(err, identity.ErrNotFound):
		writeSCIMError(w, http.StatusNotFound, "Resource not found.")
	case errors.Is(err, scim.ErrConflict), errors.Is(err, identity.ErrConflict):
		writeSCIMError(w, http.StatusConflict, "That resource already exists.")
	case errors.Is(err, identity.ErrLastAdmin):
		writeSCIMError(w, http.StatusConflict, "That membership cannot be removed.")
	default:
		writeSCIMError(w, http.StatusServiceUnavailable, "The directory is not available.")
	}
}

func decodeSCIM(w http.ResponseWriter, r *http.Request) (map[string]any, bool) {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || (media != scimMediaType && media != "application/json") {
		writeSCIMError(w, http.StatusBadRequest, "Content-Type must be application/scim+json.")
		return nil, false
	}
	dec := json.NewDecoder(io.LimitReader(r.Body, MaxRequestBody+1))
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) || errors.Is(err, io.ErrUnexpectedEOF) {
			writeSCIMError(w, http.StatusRequestEntityTooLarge, "The request body exceeds the 1048576 byte limit.")
			return nil, false
		}
		writeSCIMError(w, http.StatusBadRequest, "Request body is not valid JSON.")
		return nil, false
	}
	var extra struct{}
	if err := dec.Decode(&extra); err != io.EOF {
		writeSCIMError(w, http.StatusBadRequest, "Request body must contain a single JSON value.")
		return nil, false
	}
	if scim.RejectSecrets(raw) {
		writeSCIMError(w, http.StatusBadRequest, "Passwords and secrets are not accepted.")
		return nil, false
	}
	return raw, true
}

func scimPage(r *http.Request) (attr, value string, start, count int, err error) {
	attr, value, err = scim.ParseFilter(r.URL.Query().Get("filter"))
	if err != nil {
		return "", "", 0, 0, err
	}
	start = 1
	if raw := r.URL.Query().Get("startIndex"); raw != "" {
		n, convErr := strconv.Atoi(raw)
		if convErr != nil || n < 1 || n > 1_000_000 {
			return "", "", 0, 0, scim.ErrInvalid
		}
		start = n
	}
	count = 100
	if raw := r.URL.Query().Get("count"); raw != "" {
		n, convErr := strconv.Atoi(raw)
		if convErr != nil || n < 0 {
			return "", "", 0, 0, scim.ErrInvalid
		}
		if n > 100 {
			n = 100
		}
		count = n
	}
	return attr, value, start, count, nil
}

func scimQueryAllowed(r *http.Request) bool {
	for key := range r.URL.Query() {
		switch key {
		case "filter", "startIndex", "count":
		default:
			return false
		}
	}
	return true
}

func presentedBearer(r *http.Request) (string, bool) {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if header == "" {
		return "", false
	}
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	if token == "" || strings.Contains(token, " ") {
		return "", false
	}
	return token, true
}
