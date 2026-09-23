package webhookhttp

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
		rt.R(http.MethodGet, "/api/v1/workflows/{workflowId}/triggers", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, listWorkflowTriggers)),
		rt.R(http.MethodPost, "/api/v1/workflows/{workflowId}/triggers", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, createWorkflowTrigger)),
		rt.R(http.MethodGet, "/api/v1/triggers/{triggerId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, getTrigger)),
		rt.R(http.MethodPatch, "/api/v1/triggers/{triggerId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, updateTrigger)),
		rt.R(http.MethodPost, "/api/v1/triggers/{triggerId}/rotate", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, rotateTrigger)),
		rt.R(http.MethodPost, "/api/v1/triggers/{triggerId}/disable", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, disableTrigger)),
		rt.R(http.MethodPost, "/api/v1/triggers/{triggerId}/enable", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, enableTrigger)),
		rt.R(http.MethodDelete, "/api/v1/triggers/{triggerId}", rt.AuthAuthenticated, rt.ProxyBrowser, core.Bind(s, deleteTrigger)),
		rt.R(http.MethodPost, "/api/v1/hooks/{publicId}", rt.AuthPublic, rt.ProxyNone, core.Bind(s, deliverWebhook)),
	}
}
