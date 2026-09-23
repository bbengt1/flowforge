package oidchttp

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
		rt.R(http.MethodPost, "/api/v1/oidc/start", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, postOIDCStart)),
		rt.R(http.MethodPost, "/api/v1/oidc/callback", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, postOIDCCallback)),
	}
}
