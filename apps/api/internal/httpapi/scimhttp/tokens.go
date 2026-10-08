package scimhttp

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
)

// SCIM workspace token admin routes. A workspace token lets that
// workspace's IdP provision users into this workspace only. These routes
// mint and revoke bearers, so they need workspace.administer plus TOTP
// step-up, refuse embed sessions, and have no /embed/v1 surface. The
// plaintext token appears once, in the create response, and nowhere
// else: not in the list, the log, or the audit trail.
//
// The response shapes (ScimToken, ScimTokenList, ScimTokenCreated) are
// in openapi/components.yaml.

type createScimTokenRequest struct {
	DisplayName string `json:"displayName"`
}

// requireScimTokenAdmin is the shared door. Order: principal, embed
// refusal (before any grant or membership is read), workspace.administer
// on the server-derived workspace, then MFA step-up.
func requireScimTokenAdmin(s *core.Server, w http.ResponseWriter, r *http.Request) (identity.User, identity.Workspace, bool) {
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return identity.User{}, identity.Workspace{}, false
	}
	if pc := core.PrincipalFromRequest(r); pc != nil && pc.Session != nil && pc.Session.Binding.Bound() {
		core.WriteForbidden(w, r)
		return identity.User{}, identity.Workspace{}, false
	}
	ws, _, _, _, ok := s.RequireAccess(w, r, user, authz.PermWorkspaceAdminister)
	if !ok {
		return identity.User{}, identity.Workspace{}, false
	}
	if !s.RequireMFAStepUp(w, r) {
		return identity.User{}, identity.Workspace{}, false
	}
	return user, ws, true
}

const scimTokenNameDetail = "displayName must be 1-128 characters with no control characters."

func writeScimTokenNameInvalid(w http.ResponseWriter, r *http.Request) {
	core.WriteProblemErrors(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", scimTokenNameDetail, []core.FieldError{{
		Path: "displayName", Code: core.CodeInvalidRequest, Message: scimTokenNameDetail,
	}})
}

func scimTokenStoreUnavailable(w http.ResponseWriter, r *http.Request) {
	core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeDependencyUnavailable, "Service Unavailable", "SCIM workspace tokens are not available.")
}

func scimTokenView(t scim.Token) map[string]any {
	var createdBy any
	if t.CreatedBy != nil {
		createdBy = map[string]any{"id": t.CreatedBy.ID, "displayName": t.CreatedBy.DisplayName}
	}
	var lastUsed any
	if t.LastUsedAt != nil {
		lastUsed = t.LastUsedAt.UTC().Format(time.RFC3339)
	}
	return map[string]any{
		"id":          t.ID,
		"displayName": t.DisplayName,
		"prefix":      scim.TokenPrefix,
		"createdBy":   createdBy,
		"createdAt":   t.CreatedAt.UTC().Format(time.RFC3339),
		"lastUsedAt":  lastUsed,
	}
}

func scimAdminActor(user identity.User, r *http.Request) scim.Actor {
	return scim.Actor{UserID: user.ID, RequestID: core.RequestIDFromContext(r.Context())}
}

func listScimTokens(s *core.Server, w http.ResponseWriter, r *http.Request) {
	_, ws, ok := requireScimTokenAdmin(s, w, r)
	if !ok {
		return
	}
	if s.ScimTokens == nil {
		scimTokenStoreUnavailable(w, r)
		return
	}
	tokens, err := s.ScimTokens.ListTokens(r.Context(), ws.ID)
	if err != nil {
		scimTokenStoreUnavailable(w, r)
		return
	}
	items := make([]any, 0, len(tokens))
	for _, t := range tokens {
		items = append(items, scimTokenView(t))
	}
	core.WriteJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"maxActive":  scim.MaxActiveTokens,
		"configured": s.SCIMSettings.WorkspaceReady(),
	})
}

func createScimToken(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ws, ok := requireScimTokenAdmin(s, w, r)
	if !ok {
		return
	}
	var req createScimTokenRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if s.ScimTokens == nil {
		scimTokenStoreUnavailable(w, r)
		return
	}
	if !s.SCIMSettings.WorkspaceReady() {
		core.WriteProblem(w, r, http.StatusServiceUnavailable, core.CodeScimNotConfigured, "Service Unavailable", "SCIM is not configured on this instance.")
		return
	}
	if _, err := scim.NormalizeTokenName(req.DisplayName); err != nil {
		writeScimTokenNameInvalid(w, r)
		return
	}
	tok, plaintext, err := s.ScimTokens.CreateToken(r.Context(), ws.ID, scimAdminActor(user, r), req.DisplayName, s.ClockNow())
	switch {
	case err == nil:
	case errors.Is(err, scim.ErrTokenLimit):
		core.WriteProblem(w, r, http.StatusConflict, core.CodeScimTokenLimit, "Conflict", "This workspace already has 2 active SCIM tokens. Revoke one before creating another.")
		return
	case errors.Is(err, scim.ErrInvalid):
		writeScimTokenNameInvalid(w, r)
		return
	default:
		scimTokenStoreUnavailable(w, r)
		return
	}
	body := scimTokenView(tok)
	body["token"] = plaintext
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	core.WriteJSON(w, http.StatusCreated, body)
}

func revokeScimToken(s *core.Server, w http.ResponseWriter, r *http.Request) {
	user, ws, ok := requireScimTokenAdmin(s, w, r)
	if !ok {
		return
	}
	// A {tokenId} that is not a UUID is 404, after the door, the same as
	// an unknown id or another workspace's token.
	tokenID := strings.TrimSpace(r.PathValue("tokenId"))
	if !authz.ValidUUID(tokenID) {
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	if s.ScimTokens == nil {
		scimTokenStoreUnavailable(w, r)
		return
	}
	switch err := s.ScimTokens.RevokeToken(r.Context(), ws.ID, tokenID, scimAdminActor(user, r), s.ClockNow()); {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, scim.ErrNotFound):
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
	default:
		scimTokenStoreUnavailable(w, r)
	}
}
