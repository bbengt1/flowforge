package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes1(s *Server) []rt.Route {
	if s == nil {
		s = &Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/health", rt.AuthPublic, rt.ProxyNone, s.Health),
		rt.R(http.MethodGet, "/api/v1/readiness", rt.AuthPublic, rt.ProxyNone, s.Readiness),
	}
}
