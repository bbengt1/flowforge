package httpapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/portal"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func (s *Server) getPortalAdapter(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, portal.NewCatalog(s.portalIssuers, s.portalFrames))
}

func (s *Server) mintPortalAssertion(w http.ResponseWriter, r *http.Request) {
	if !s.requireEmbedKeys(w, r) {
		return
	}
	user, ok := s.requirePrincipal(w, r)
	if !ok {
		return
	}
	ws, tenant, _, perms, ok := s.requireAccess(w, r, user, "")
	if !ok {
		return
	}
	var req portal.MintRequest
	if !DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.WorkspaceID) != "" {
		if err := authz.ConfirmResolvedID(ws.ID, req.WorkspaceID); err != nil {
			writeIdentityError(w, r, err)
			return
		}
	}
	if id := strings.TrimSpace(req.TenantID); id != "" && !strings.EqualFold(id, tenant.ID) {
		writeIdentityError(w, r, authz.ErrWorkspaceIdentityMismatch)
		return
	}
	if key := strings.TrimSpace(req.WorkbenchKey); key != "" && key != ws.WorkbenchKey {
		writeIdentityError(w, r, authz.ErrWorkspaceIdentityMismatch)
		return
	}
	in, caps, err := portal.PrepareMint(req, user.Issuer, user.ExternalSubject, user.DisplayName, tenant.ID, ws.WorkbenchKey, ws.ID, s.portalIssuers, s.clockNow())
	if err != nil {
		writePortalError(w, r, err)
		return
	}
	for _, c := range caps {
		if !authz.Allows(perms, c) {
			WriteForbidden(w, r)
			return
		}
	}
	minted, _, err := embed.Mint(s.embedMaterial(), in)
	if err != nil {
		writeEmbedError(w, r, err)
		return
	}
	s.auditEmbed(r, "portal.minted", session.OutcomeAllowed, "issued", minted.TokenID, minted.KeyID, minted.Issuer, minted.Subject)
	writeJSON(w, http.StatusCreated, minted)
}

func writePortalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, portal.ErrRoleRequired), errors.Is(err, portal.ErrUnknownRole),
		errors.Is(err, portal.ErrUnknownCapability):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Portal roles or capabilities are missing or not in the capability map.")
	case errors.Is(err, portal.ErrPlatformCapability):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Portal capabilities must not include platform.administer.")
	case errors.Is(err, portal.ErrIssuer), errors.Is(err, portal.ErrHostileHost):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Portal issuer is not on the allowlist.")
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The portal adapter request is not valid.")
	}
}
