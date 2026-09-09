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
	in, caps, impersonating, err := portal.PrepareMint(req, user.Issuer, user.ExternalSubject, user.DisplayName, tenant.ID, ws.WorkbenchKey, ws.ID, s.portalIssuers, s.clockNow(), authz.CanEmbedImpersonate(user.Issuer, user.ExternalSubject, s.platformAdmins))
	if err != nil {
		if errors.Is(err, authz.ErrMintImpersonation) || errors.Is(err, authz.ErrMintIssuerSpoof) {
			reason := "impersonation"
			if errors.Is(err, authz.ErrMintIssuerSpoof) {
				reason = "issuer"
			}
			s.auditEmbed(r, "portal.rejected", session.OutcomeDenied, reason, "", s.embedMaterial().KeyID, user.Issuer, user.ExternalSubject)
			if pc := principalFromRequest(r); pc != nil && pc.session != nil {
				s.auditSession(r, *pc.session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing embed.impersonate")
			}
			WriteForbidden(w, r)
			return
		}
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
	reason := "issued"
	if impersonating {
		reason = "impersonated"
	}
	s.auditEmbed(r, "portal.minted", session.OutcomeAllowed, reason, minted.TokenID, minted.KeyID, minted.Issuer, minted.Subject)
	writeJSON(w, http.StatusCreated, minted)
}

func writePortalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, portal.ErrRoleRequired), errors.Is(err, portal.ErrUnknownRole),
		errors.Is(err, portal.ErrUnknownCapability):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Portal roles or capabilities are missing or not in the capability map.")
	case errors.Is(err, portal.ErrPlatformCapability):
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "Portal capabilities must not include platform.administer.")
	case errors.Is(err, authz.ErrMintImpersonation):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Mint subject must match the authenticated caller unless embed.impersonate is granted.")
	case errors.Is(err, authz.ErrMintIssuerSpoof):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Mint issuer must match the authenticated caller.")
	case errors.Is(err, portal.ErrIssuer), errors.Is(err, portal.ErrHostileHost):
		WriteProblem(w, r, http.StatusForbidden, CodeForbidden, "Forbidden", "Portal issuer is not on the allowlist. Empty PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST fails closed.")
	default:
		WriteProblem(w, r, http.StatusBadRequest, CodeInvalidRequest, "Invalid Request", "The portal adapter request is not valid.")
	}
}
