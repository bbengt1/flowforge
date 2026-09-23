package workflowhttp

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/core"
	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
)

func OpsRoutes(s *core.Server) []rt.Route {
	var out []rt.Route
	for _, info := range opsconfig.KindInfos() {
		kind := info.Kind
		col := "/api/v1/" + info.Collection
		out = append(out,
			rt.RRef(http.MethodGet, col, rt.AuthAuthenticated, rt.ProxyBrowser, refOpsCollection, listOpsResources(s, kind)),
			rt.RRef(http.MethodPost, col, rt.AuthAuthenticated, rt.ProxyBrowser, refOpsCollection, CreateOpsResource(s, kind)),
			rt.RRef(http.MethodGet, col+"/{resourceId}", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsItem, getOpsResource(s, kind)),
			rt.RRef(http.MethodGet, col+"/{resourceId}/draft", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsDraft, getOpsDraft(s, kind)),
			rt.RRef(http.MethodPut, col+"/{resourceId}/draft", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsDraft, putOpsDraft(s, kind)),
			rt.RRef(http.MethodPost, col+"/{resourceId}/publish", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsPublish, publishOpsResource(s, kind)),
			rt.RRef(http.MethodGet, col+"/{resourceId}/versions", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsVersions, listOpsVersions(s, kind)),
			rt.RRef(http.MethodGet, col+"/{resourceId}/versions/{versionId}", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsVersion, getOpsVersion(s, kind)),
			rt.RRef(http.MethodPost, col+"/{resourceId}/disable", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsDisable, disableOpsResource(s, kind)),
			rt.RRef(http.MethodPost, col+"/{resourceId}/enable", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsEnable, enableOpsResource(s, kind)),
			rt.RRef(http.MethodPost, col+"/{resourceId}/select", rt.AuthAuthenticated, rt.ProxyBrowser, refOpsSelect, selectOpsResource(s, kind)),
		)
	}
	return out
}

const (
	refOpsCollection = "#/components/pathItems/OpsCollection"
	refOpsItem       = "#/components/pathItems/OpsItem"
	refOpsDraft      = "#/components/pathItems/OpsDraft"
	refOpsPublish    = "#/components/pathItems/OpsPublish"
	refOpsVersions   = "#/components/pathItems/OpsVersions"
	refOpsVersion    = "#/components/pathItems/OpsVersion"
	refOpsDisable    = "#/components/pathItems/OpsDisable"
	refOpsEnable     = "#/components/pathItems/OpsEnable"
	refOpsSelect     = "#/components/pathItems/OpsSelect"
)
