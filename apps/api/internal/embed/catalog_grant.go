package embed

import (
	"slices"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

// Membership / isolation catalog route ids. Hidden unless the caller
// presents workspace.administer or platform.administer (ADV-024).
const (
	RouteIDMembership = "membership"
	RouteIDIsolation  = "isolation"
)

// EssentialAPIPaths are the unauthenticated embed-catalog surfaces:
// exchange, session, chrome, and public JWKS. Mint/rotate and
// membership bootstrap stay off this list.
var EssentialAPIPaths = []string{
	"/api/v1/embed/catalog",
	"/api/v1/session",
	"/api/v1/embed/jwks",
	"/api/v1/embed/exchange",
}

// EssentialHookIDs stay on the minimized catalog so CSP, exchange,
// and ADV-021 chrome keep working without membership disclosure.
var EssentialHookIDs = []string{
	"jti.consume",
	"assertion.verify-before-lookup",
	"exchange.host-issuer",
	"chips.embed-cookies",
	"exchange.rate-limit",
	"host.allowlist",
	"chrome.from-session",
}

// CatalogView is the caller's disclosure context for GET /embed/catalog
// and GET /portal/adapter. Unauthenticated or capability-less embed
// sessions fail closed to essentials (ADV-024).
type CatalogView struct {
	// Authenticated is true when a valid ff_session was peeked.
	Authenticated bool
	// EmbedBound is true when that session carries an embed tenancy bind.
	EmbedBound bool
	// Capabilities are session-capped (embed) or membership-derived
	// (standalone). Used only to decide membership/isolation grant.
	Capabilities []string
}

// GrantsMembershipIsolation reports whether caps include the catalog
// grant for membership/isolation internals. There is no membership.*
// family — workspace.administer is the membership operator cap;
// platform.administer is the bootstrap/admin cap.
func GrantsMembershipIsolation(caps []string) bool {
	return authz.Allows(caps, authz.PermWorkspaceAdminister) || authz.Allows(caps, authz.PermPlatformAdminister)
}

// GrantsMembershipIsolation reports the view's grant.
func (v CatalogView) GrantsMembershipIsolation() bool {
	return GrantsMembershipIsolation(v.Capabilities)
}

// Minimize reports whether the catalog must shrink to
// exchange/session/chrome essentials. Standalone authenticated
// sessions keep the product route map (already gated by authz
// elsewhere) minus membership/isolation unless granted.
func (v CatalogView) Minimize() bool {
	if !v.Authenticated {
		return true
	}
	return v.EmbedBound && len(v.Capabilities) == 0
}

// IsMembershipIsolationRoute reports a membership operator or
// isolation-exercise catalog route.
func IsMembershipIsolationRoute(id string) bool {
	return id == RouteIDMembership || id == RouteIDIsolation
}

// FilterMembershipIsolationRoutes drops membership/isolation mounts.
func FilterMembershipIsolationRoutes(routes []Route) []Route {
	out := make([]Route, 0, len(routes))
	for _, r := range routes {
		if IsMembershipIsolationRoute(r.ID) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// FilterMembershipIsolationCapabilities drops membership/admin caps
// that would advertise tenant bootstrap or the membership operator.
func FilterMembershipIsolationCapabilities(caps []string) []string {
	out := make([]string, 0, len(caps))
	for _, c := range caps {
		if c == authz.PermWorkspaceAdminister || c == authz.PermPlatformAdminister {
			continue
		}
		out = append(out, c)
	}
	return out
}

// CatalogDisclosesMembershipIsolation reports routes or capabilities
// that reveal membership/isolation internals.
func CatalogDisclosesMembershipIsolation(c Catalog) bool {
	if c.Rules.MembershipIsolationGranted {
		return true
	}
	for _, r := range c.Routes {
		if IsMembershipIsolationRoute(r.ID) {
			return true
		}
	}
	return slices.Contains(c.Capabilities, authz.PermWorkspaceAdminister) ||
		slices.Contains(c.Capabilities, authz.PermPlatformAdminister)
}

func applyCatalogView(c Catalog, view CatalogView) Catalog {
	granted := view.GrantsMembershipIsolation()
	c.Rules.MembershipIsolationRequiresGrant = true
	c.Rules.MembershipIsolationGranted = granted
	if view.Minimize() {
		c = minimizeCatalog(c)
	}
	if !granted {
		c.Routes = FilterMembershipIsolationRoutes(c.Routes)
		c.Capabilities = FilterMembershipIsolationCapabilities(c.Capabilities)
	}
	return c
}

func minimizeCatalog(c Catalog) Catalog {
	c.Capabilities = []string{}
	home := make([]Route, 0, 1)
	for _, r := range c.Routes {
		if r.ID == "home" {
			home = append(home, r)
			break
		}
	}
	c.Routes = home
	api := make([]APIRoute, 0, len(EssentialAPIPaths))
	for _, r := range c.API {
		if slices.Contains(EssentialAPIPaths, r.Path) {
			api = append(api, r)
		}
	}
	c.API = api
	hooks := make([]HookStatus, 0, len(EssentialHookIDs))
	for _, h := range c.Hooks {
		if slices.Contains(EssentialHookIDs, h.ID) {
			hooks = append(hooks, h)
		}
	}
	c.Hooks = hooks
	return c
}
