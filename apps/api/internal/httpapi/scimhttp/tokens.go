package scimhttp

import (
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
)

// SCIM workspace token admin routes. A workspace token lets that
// workspace's IdP provision users into this workspace only. These routes
// mint and revoke bearers, so they need workspace.administer plus TOTP
// step-up, refuse embed sessions, and have no /embed/v1 surface. The
// plaintext token appears once, in the create response, and nowhere
// else: not in the list, the log, or the audit trail.
//
// Contract only for now: every route runs the full door and then
// answers 501 until the store lands.

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

func writeScimTokensNotImplemented(w http.ResponseWriter, r *http.Request) {
	core.WriteProblem(w, r, http.StatusNotImplemented, core.CodeInternalError, "Not Implemented", "SCIM workspace tokens are not available yet.")
}

func listScimTokens(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if _, _, ok := requireScimTokenAdmin(s, w, r); !ok {
		return
	}
	writeScimTokensNotImplemented(w, r)
}

func createScimToken(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if _, _, ok := requireScimTokenAdmin(s, w, r); !ok {
		return
	}
	var req createScimTokenRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	writeScimTokensNotImplemented(w, r)
}

func revokeScimToken(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if _, _, ok := requireScimTokenAdmin(s, w, r); !ok {
		return
	}
	// A {tokenId} that is not a UUID is 404, after the door, the same as
	// an unknown id or another workspace's token.
	if !authz.ValidUUID(strings.TrimSpace(r.PathValue("tokenId"))) {
		core.WriteProblem(w, r, http.StatusNotFound, core.CodeNotFound, "Not Found", "The requested resource was not found.")
		return
	}
	writeScimTokensNotImplemented(w, r)
}
