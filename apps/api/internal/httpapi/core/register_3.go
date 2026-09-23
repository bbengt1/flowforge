package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes4(s *Server) []rt.Route {
	if s == nil {
		s = &Server{}
	}
	return []rt.Route{
		rt.R(http.MethodGet, "/api/v1/users/{userID}/lockout", rt.AuthAuthenticated, rt.ProxyNone, s.getAccountLockout),
		rt.R(http.MethodPost, "/api/v1/users/{userID}/unlock", rt.AuthAuthenticated, rt.ProxyNone, s.postAccountUnlock),
	}
}
