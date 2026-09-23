package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes6(s *Server) []rt.Route {
	if s == nil {
		s = &Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/alerts", rt.AuthAuthenticated, rt.ProxyBrowser, s.listOperationalAlerts),
		rt.R(http.MethodGet, "/api/v1/alerts/{alertId}", rt.AuthAuthenticated, rt.ProxyBrowser, s.getOperationalAlert),
		rt.R(http.MethodPost, "/api/v1/alerts/{alertId}/ack", rt.AuthAuthenticated, rt.ProxyBrowser, s.ackOperationalAlert),
	}
}
