package vaulthttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes(s *core.Server) []rt.Route {
	if s == nil {
		s = &core.Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/credentials/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getCredentialCatalog)),
		rt.R(http.MethodGet, "/api/v1/credentials", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listCredentials)),
		rt.R(http.MethodPost, "/api/v1/credentials", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createCredential)),
		rt.R(http.MethodGet, "/api/v1/credentials/{credentialId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getCredential)),
		rt.R(http.MethodPatch, "/api/v1/credentials/{credentialId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, updateCredential)),
		rt.R(http.MethodPost, "/api/v1/credentials/{credentialId}/rotate", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, rotateCredential)),
		rt.R(http.MethodPost, "/api/v1/credentials/{credentialId}/disable", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, disableCredential)),
		rt.R(http.MethodPost, "/api/v1/credentials/{credentialId}/enable", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, enableCredential)),
		rt.R(http.MethodPost, "/api/v1/credentials/{credentialId}/test", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, testCredential)),
		rt.R(http.MethodPost, "/api/v1/credentials/{credentialId}/use", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, useVaultCredential)),
		rt.R(http.MethodGet, "/api/v1/credentials/{credentialId}/usage", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getCredentialUsage)),
		rt.R(http.MethodGet, "/api/v1/credentials/{credentialId}/deletion-impact", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getCredentialDeletionImpact)),
		rt.R(http.MethodDelete, "/api/v1/credentials/{credentialId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, deleteCredential)),
		rt.R(http.MethodGet, "/api/v1/credentials/{credentialId}/events", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listCredentialEvents)),
	}
}
