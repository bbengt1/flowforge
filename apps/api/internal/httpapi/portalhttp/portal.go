package portalhttp

import (
	"errors"
	"net/http"
	"strings"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/portal"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func getPortalAdapter(s *core.Server, w http.ResponseWriter, r *http.Request) {
	core.WriteJSON(w, http.StatusOK, portal.NewCatalogFor(s.PortalIssuers, s.PortalFrames, s.PeekCatalogView(r)))
}

func mintPortalAssertion(s *core.Server, w http.ResponseWriter, r *http.Request) {
	if !s.RequireEmbedKeys(w, r) {
		return
	}
	user, ok := s.RequirePrincipal(w, r)
	if !ok {
		return
	}
	ok, retry, err := s.AllowEmbedMint(r, user.Issuer, user.ExternalSubject)
	if err != nil {
		core.WriteRateStoreUnavailable(w, r)
		return
	}
	if !ok {
		s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, embed.ReasonRateLimited, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		core.WriteRateLimited(w, r, retry, "Embed mint rate limit exceeded. Retry after the configured window.")
		return
	}
	ws, tenant, _, perms, ok := s.RequireAccess(w, r, user, "")
	if !ok {
		return
	}
	var req portal.MintRequest
	if !core.DecodeJSON(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.WorkspaceID) != "" {
		if err := authz.ConfirmResolvedID(ws.ID, req.WorkspaceID); err != nil {
			s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, embed.ReasonTenancy, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
			core.WriteIdentityError(w, r, err)
			return
		}
	}
	if id := strings.TrimSpace(req.TenantID); id != "" && !strings.EqualFold(id, tenant.ID) {
		s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, embed.ReasonTenancy, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		core.WriteIdentityError(w, r, authz.ErrWorkspaceIdentityMismatch)
		return
	}
	if key := strings.TrimSpace(req.WorkbenchKey); key != "" && key != ws.WorkbenchKey {
		s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, embed.ReasonTenancy, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		core.WriteIdentityError(w, r, authz.ErrWorkspaceIdentityMismatch)
		return
	}
	in, caps, impersonating, err := portal.PrepareMint(req, user.Issuer, user.ExternalSubject, user.DisplayName, tenant.ID, ws.WorkbenchKey, ws.ID, s.PortalIssuers, s.ClockNow(), authz.CanEmbedImpersonate(user.Issuer, user.ExternalSubject, s.PlatformAdmins))
	if err != nil {
		if errors.Is(err, authz.ErrMintImpersonation) || errors.Is(err, authz.ErrMintIssuerSpoof) {
			reason := embed.ReasonImpersonation
			if errors.Is(err, authz.ErrMintIssuerSpoof) {
				reason = embed.ReasonIssuer
			}
			s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, reason, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
			if pc := core.PrincipalFromRequest(r); pc != nil && pc.Session != nil {
				s.AuditSession(r, *pc.Session, session.EventPrivilegeDenied, session.OutcomeDenied, "missing embed.impersonate")
			}
			core.WriteForbidden(w, r)
			return
		}
		reason := embed.ReasonRejected
		if errors.Is(err, portal.ErrIssuer) || errors.Is(err, portal.ErrHostileHost) {
			reason = embed.ReasonIssuer
		}
		s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, reason, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
		writePortalError(w, r, err)
		return
	}
	for _, c := range caps {
		if !authz.Allows(perms, c) {
			s.AuditEmbed(r, embed.EventPortalRejected, session.OutcomeDenied, embed.ReasonCapability, "", s.EmbedMaterial().KeyID, user.Issuer, user.ExternalSubject)
			core.WriteForbidden(w, r)
			return
		}
	}
	minted, _, err := embed.Mint(s.EmbedMaterial(), in)
	if err != nil {
		core.WriteEmbedError(w, r, err)
		return
	}
	reason := embed.ReasonIssued
	if impersonating {
		reason = embed.ReasonImpersonated
	}
	s.AuditEmbed(r, embed.EventPortalMinted, session.OutcomeAllowed, reason, minted.TokenID, minted.KeyID, minted.Issuer, minted.Subject)
	core.WriteJSON(w, http.StatusCreated, minted)
}

func writePortalError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, portal.ErrRoleRequired), errors.Is(err, portal.ErrUnknownRole),
		errors.Is(err, portal.ErrUnknownCapability):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Portal roles or capabilities are missing or not in the capability map.")
	case errors.Is(err, portal.ErrPlatformCapability):
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "Portal capabilities must not include platform.administer.")
	case errors.Is(err, authz.ErrMintImpersonation):
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "Mint subject must match the authenticated caller unless embed.impersonate is granted.")
	case errors.Is(err, authz.ErrMintIssuerSpoof):
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "Mint issuer must match the authenticated caller.")
	case errors.Is(err, portal.ErrIssuer), errors.Is(err, portal.ErrHostileHost):
		core.WriteProblem(w, r, http.StatusForbidden, core.CodeForbidden, "Forbidden", "Portal issuer is not on the allowlist. Empty PORTAL_ISSUER / PORTAL_ISSUER_ALLOWLIST fails closed.")
	default:
		core.WriteProblem(w, r, http.StatusBadRequest, core.CodeInvalidRequest, "Invalid Request", "The portal adapter request is not valid.")
	}
}
