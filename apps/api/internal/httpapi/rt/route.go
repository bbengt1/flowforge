package rt

import (
	"net/http"
	"strings"
)

// AuthClass is the route-table classification published in OpenAPI.
// Handlers still enforce the real door. This label does not grant access.
const (
	// AuthPublic is reachable without a session: probes, first-run
	// bootstrap, login/OIDC, machine-token exchange, and signed webhook
	// ingress. Bootstrap fail-closes once install is complete.
	AuthPublic AuthClass = "public"
	// AuthEmbed is an embed or portal surface that answers without a
	// browser session (catalog, JWKS, exchange, portal adapter).
	// Mint and key rotation stay AuthAuthenticated.
	AuthEmbed AuthClass = "embed"
	// AuthAuthenticated requires a principal (session, worker credential,
	// SCIM bearer, or platform ops). It is not an anonymous door.
	AuthAuthenticated AuthClass = "authenticated"
)

// AuthClass classifies who may call a route.
type AuthClass string

// ProxyClass says whether the Next identity proxy may forward the route.
const (
	// ProxyBrowser is on the generated identity-proxy allowlist.
	ProxyBrowser ProxyClass = "browser"
	// ProxyNone stays off the browser allowlist: probes, platform scrape,
	// webhook ingress, worker job protocol, SCIM, machine-principal admin,
	// account lockout, and worker upload / retention maintenance.
	ProxyNone ProxyClass = "none"
)

// ProxyClass is the identity-proxy audience for one method.
type ProxyClass string

// Route is one mux registration. Routes is the source of truth for the
// mux, the generated OpenAPI document, and the identity-proxy allowlist.
type Route struct {
	Method  string
	Pattern string
	Auth    AuthClass
	Proxy   ProxyClass
	// SpecRef is an OpenAPI path-item $ref shared by ops-config collections.
	SpecRef string
	Handler http.HandlerFunc
}

// OpenAPIPath is the path key under servers.url /api/v1.
// Routes outside that prefix (SCIM) keep their origin path.
func (r Route) OpenAPIPath() string {
	const prefix = "/api/v1"
	if r.Pattern == prefix {
		return "/"
	}
	if strings.HasPrefix(r.Pattern, prefix+"/") {
		return strings.TrimPrefix(r.Pattern, prefix)
	}
	return r.Pattern
}

// R builds a route record.
func R(method, pattern string, auth AuthClass, proxy ProxyClass, h http.HandlerFunc) Route {
	return Route{Method: method, Pattern: pattern, Auth: auth, Proxy: proxy, Handler: h}
}

// RRef builds a route record that shares an OpenAPI path item.
func RRef(method, pattern string, auth AuthClass, proxy ProxyClass, ref string, h http.HandlerFunc) Route {
	r := R(method, pattern, auth, proxy, h)
	r.SpecRef = ref
	return r
}
