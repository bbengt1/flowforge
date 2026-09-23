package workflowhttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes4(s *core.Server) []rt.Route {
	if s == nil {
		s = &core.Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/ops-config/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getOpsCatalog)),
		rt.R(http.MethodGet, "/api/v1/kubernetes/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getKubernetesCatalog)),
		rt.R(http.MethodGet, "/api/v1/ssh/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getSSHCatalog)),
		rt.R(http.MethodGet, "/api/v1/scripts/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getScriptCatalog)),
		rt.R(http.MethodGet, "/api/v1/http/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getHTTPCatalog)),
		rt.R(http.MethodPost, "/api/v1/scripts", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, publishScript)),
		rt.R(http.MethodGet, "/api/v1/scripts/{artifactId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getScriptArtifact)),
		rt.R(http.MethodPost, "/api/v1/scripts/{artifactId}/revoke", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, revokeScriptArtifact)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}/script-artifacts", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflowScriptArtifacts)),
		rt.R(http.MethodPost, "/api/v1/ops-config/select", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, selectOpsBatch)),
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/versions/{versionId}/pins", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflowVersionPins)),
	}
}
