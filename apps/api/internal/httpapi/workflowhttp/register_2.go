package workflowhttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes3(s *core.Server) []rt.Route {
	if s == nil {
		s = &core.Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/artifacts/{artifactId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getProductArtifact)),
		rt.R(http.MethodPost, "/api/v1/artifacts/{artifactId}/downloads", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createArtifactDownload)),
		rt.R(http.MethodGet, "/api/v1/artifact-downloads/{grantId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, streamArtifactDownload)),
		rt.R(http.MethodPost, "/api/v1/artifacts/{artifactId}/legal-hold", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, setArtifactLegalHold)),
		rt.R(http.MethodPost, "/api/v1/retention/purge", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, purgeRetention)),
	}
}
