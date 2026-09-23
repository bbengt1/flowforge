package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes2(s *Server) []rt.Route {
	if s == nil {
		s = &Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/metrics", rt.AuthAuthenticated, rt.ProxyNone, s.Metrics),
		rt.R(http.MethodGet, "/api/v1/openapi.yaml", rt.AuthAuthenticated, rt.ProxyNone, s.openapiYAML),
		rt.R(http.MethodGet, "/api/v1/openapi.json", rt.AuthAuthenticated, rt.ProxyNone, s.openapiJSON),
		rt.R(http.MethodGet, "/api/v1/swagger", rt.AuthAuthenticated, rt.ProxyNone, s.Swagger),
		rt.R(http.MethodGet, "/api/v1/permission-matrix", rt.AuthAuthenticated, rt.ProxyBrowser, s.getPermissionMatrix),
		rt.R(http.MethodGet, "/api/v1/roles", rt.AuthAuthenticated, rt.ProxyBrowser, s.getRoles),
		rt.R(http.MethodGet, "/api/v1/permissions", rt.AuthAuthenticated, rt.ProxyBrowser, s.getPermissions),
		rt.R(http.MethodPost, "/api/v1/tenants", rt.AuthAuthenticated, rt.ProxyBrowser, s.createTenant),
		rt.R(http.MethodGet, "/api/v1/workspaces", rt.AuthAuthenticated, rt.ProxyBrowser, s.listWorkspaces),
		rt.R(http.MethodPost, "/api/v1/workspaces", rt.AuthAuthenticated, rt.ProxyBrowser, s.createWorkspace),
		rt.R(http.MethodGet, "/api/v1/workspace", rt.AuthAuthenticated, rt.ProxyBrowser, s.getCurrentWorkspace),
		rt.R(http.MethodDelete, "/api/v1/workspace", rt.AuthAuthenticated, rt.ProxyBrowser, s.deleteWorkspace),
		rt.R(http.MethodGet, "/api/v1/workspace/members", rt.AuthAuthenticated, rt.ProxyBrowser, s.listMembers),
		rt.R(http.MethodPut, "/api/v1/workspace/members", rt.AuthAuthenticated, rt.ProxyBrowser, s.PutMember),
		rt.R(http.MethodDelete, "/api/v1/workspace/members/{userID}", rt.AuthAuthenticated, rt.ProxyBrowser, s.deleteMember),
	}
}
