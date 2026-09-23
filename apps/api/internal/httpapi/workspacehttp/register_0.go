package workspacehttp

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
		rt.R(http.MethodGet, "/api/v1/workspace/records", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listRecords)),
		rt.R(http.MethodPost, "/api/v1/workspace/records", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createRecord)),
		rt.R(http.MethodGet, "/api/v1/workspace/records/{id}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getRecord)),
		rt.R(http.MethodPost, "/api/v1/workspace/records/{id}/links", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createRecordLink)),
		rt.R(http.MethodPost, "/api/v1/workspace/credentials/{id}/use", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, useCredential)),
		rt.R(http.MethodGet, "/api/v1/workspace/artifacts/{id}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getArtifact)),
		rt.R(http.MethodGet, "/api/v1/workspace/jobs", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listJobs)),
		rt.R(http.MethodPost, "/api/v1/workspace/jobs", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createJob)),
		rt.R(http.MethodGet, "/api/v1/workspace/cache/{key}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getCache)),
		rt.R(http.MethodPut, "/api/v1/workspace/cache/{key}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, putCache)),
		rt.R(http.MethodPost, "/api/v1/workspace/realtime/channels/{id}/subscribe", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, subscribeRealtime)),
		rt.R(http.MethodGet, "/api/v1/workspace/audit-events", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listAuditEvents)),
	}
}
