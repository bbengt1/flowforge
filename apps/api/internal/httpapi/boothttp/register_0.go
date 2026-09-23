package boothttp

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
		rt.R(http.MethodGet, "/api/v1/bootstrap", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, getBootstrap)),
		rt.R(http.MethodPost, "/api/v1/bootstrap/persistence", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, postBootstrapPersistence)),
		rt.R(http.MethodPost, "/api/v1/bootstrap/admins", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, postBootstrapAdmins)),
		rt.R(http.MethodPost, "/api/v1/bootstrap/public-url", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, postBootstrapPublicURL)),
		rt.R(http.MethodPost, "/api/v1/bootstrap/tls", rt.AuthPublic, rt.ProxyBrowser, core.Bind(s, postBootstrapTLS)),
	}
}
