package approvalhttp

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
		rt.R(http.MethodGet, "/api/v1/approvals/catalog", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getApprovalCatalog)),
		rt.R(http.MethodPost, "/api/v1/policy/evaluate", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, evaluatePolicy)),
		rt.R(http.MethodGet, "/api/v1/approvals", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listApprovals)),
		rt.R(http.MethodPost, "/api/v1/approvals", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createApprovals)),
		rt.R(http.MethodGet, "/api/v1/approvals/{approvalId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getApproval)),
		rt.R(http.MethodPost, "/api/v1/approvals/{approvalId}/decide", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, decideApproval)),
		rt.R(http.MethodGet, "/api/v1/approvals/{approvalId}/events", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listApprovalEvents)),
	}
}
