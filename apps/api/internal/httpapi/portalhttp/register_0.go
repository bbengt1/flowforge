package portalhttp

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
		rt.R(http.MethodGet, "/api/v1/portal/adapter", rt.AuthEmbed, rt.ProxyBrowser, core.Bind(s, getPortalAdapter)),
		rt.R(http.MethodPost, "/api/v1/portal/adapter/assertions", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, mintPortalAssertion)),
	}
}
