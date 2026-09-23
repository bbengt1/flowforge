package scimhttp

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
		rt.R(http.MethodGet, "/scim/v2/ServiceProviderConfig", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, getSCIMServiceProviderConfig)),
		rt.R(http.MethodGet, "/scim/v2/Schemas", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, getSCIMSchemas)),
		rt.R(http.MethodGet, "/scim/v2/ResourceTypes", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, getSCIMResourceTypes)),
		rt.R(http.MethodGet, "/scim/v2/Users", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, listSCIMUsers)),
		rt.R(http.MethodPost, "/scim/v2/Users", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, postSCIMUser)),
		rt.R(http.MethodGet, "/scim/v2/Users/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, getSCIMUser)),
		rt.R(http.MethodPut, "/scim/v2/Users/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, putSCIMUser)),
		rt.R(http.MethodPatch, "/scim/v2/Users/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, patchSCIMUser)),
		rt.R(http.MethodDelete, "/scim/v2/Users/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, deleteSCIMUser)),
		rt.R(http.MethodGet, "/scim/v2/Groups", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, listSCIMGroups)),
		rt.R(http.MethodPost, "/scim/v2/Groups", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, postSCIMGroup)),
		rt.R(http.MethodGet, "/scim/v2/Groups/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, getSCIMGroup)),
		rt.R(http.MethodPut, "/scim/v2/Groups/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, putSCIMGroup)),
		rt.R(http.MethodPatch, "/scim/v2/Groups/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, patchSCIMGroup)),
		rt.R(http.MethodDelete, "/scim/v2/Groups/{id}", rt.AuthAuthenticated, rt.ProxyNone, core.Bind(s, deleteSCIMGroup)),
	}
}
