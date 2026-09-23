package core

import (
	"net/http"

	"github.com/bbengt1/flowforge/apps/api/internal/httpapi/rt"
)

func Routes3(s *Server) []rt.Route {
	if s == nil {
		s = &Server{}
	}
	return []rt.Route{
		rt.R(http.MethodPost, "/api/v1/login", rt.AuthPublic, rt.ProxyBrowser, s.postLogin),
	}
}
