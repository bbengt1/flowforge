package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes5(s *Server) []rt.Route {
	if s == nil {
		s = &Server{}
	}
	return []rt.Route{
		rt.R(http.MethodPost, "/api/v1/machine/token", rt.AuthPublic, rt.ProxyNone, s.postMachineToken),
		rt.R(http.MethodGet, "/api/v1/machine/principals", rt.AuthAuthenticated, rt.ProxyNone, s.listMachinePrincipals),
		rt.R(http.MethodPost, "/api/v1/machine/principals", rt.AuthAuthenticated, rt.ProxyNone, s.postMachinePrincipal),
		rt.R(http.MethodGet, "/api/v1/machine/principals/{id}", rt.AuthAuthenticated, rt.ProxyNone, s.getMachinePrincipal),
		rt.R(http.MethodPost, "/api/v1/machine/principals/{id}/rotate", rt.AuthAuthenticated, rt.ProxyNone, s.rotateMachinePrincipal),
		rt.R(http.MethodPost, "/api/v1/machine/principals/{id}/revoke", rt.AuthAuthenticated, rt.ProxyNone, s.revokeMachinePrincipal),
		rt.R(http.MethodPost, "/api/v1/session", rt.AuthAuthenticated, rt.ProxyBrowser, s.CreateSession),
		rt.R(http.MethodGet, "/api/v1/session", rt.AuthAuthenticated, rt.ProxyBrowser, s.getSession),
		rt.R(http.MethodPost, "/api/v1/session/refresh", rt.AuthAuthenticated, rt.ProxyBrowser, s.refreshSession),
		rt.R(http.MethodPost, "/api/v1/session/logout", rt.AuthAuthenticated, rt.ProxyBrowser, s.logoutSession),
		rt.R(http.MethodPost, "/api/v1/session/password", rt.AuthAuthenticated, rt.ProxyBrowser, s.postSessionPassword),
		rt.R(http.MethodGet, "/api/v1/session/mfa", rt.AuthAuthenticated, rt.ProxyBrowser, s.getSessionMFA),
		rt.R(http.MethodPost, "/api/v1/session/mfa/enroll", rt.AuthAuthenticated, rt.ProxyBrowser, s.postSessionMFAEnroll),
		rt.R(http.MethodPost, "/api/v1/session/mfa/verify", rt.AuthAuthenticated, rt.ProxyBrowser, s.postSessionMFAVerify),
		rt.R(http.MethodGet, "/api/v1/session/audit-events", rt.AuthAuthenticated, rt.ProxyBrowser, s.listSessionAudit),
		rt.R(http.MethodGet, "/api/v1/embed/catalog", rt.AuthEmbed, rt.ProxyBrowser, s.getEmbedCatalog),
		rt.R(http.MethodGet, "/api/v1/embed/jwks", rt.AuthEmbed, rt.ProxyBrowser, s.getEmbedJWKS),
		rt.R(http.MethodPost, "/api/v1/embed/assertions", rt.AuthAuthenticated, rt.ProxyBrowser, s.mintEmbedAssertion),
		rt.R(http.MethodPost, "/api/v1/embed/exchange", rt.AuthEmbed, rt.ProxyBrowser, s.exchangeEmbedAssertion),
		rt.R(http.MethodPost, "/api/v1/embed/keys/rotate", rt.AuthAuthenticated, rt.ProxyBrowser, s.rotateEmbedKeys),
	}
}
