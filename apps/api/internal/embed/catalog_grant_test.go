package embed

import (
	"slices"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestGrantsMembershipIsolation(t *testing.T) {
	if GrantsMembershipIsolation(nil) || GrantsMembershipIsolation([]string{authz.PermWorkflowView}) {
		t.Fatal("viewer must not grant membership/isolation catalog")
	}
	if !GrantsMembershipIsolation([]string{authz.PermWorkspaceAdminister}) {
		t.Fatal("workspace.administer must grant")
	}
	if !GrantsMembershipIsolation([]string{authz.PermPlatformAdminister}) {
		t.Fatal("platform.administer must grant")
	}
}

func TestCatalogViewMinimize(t *testing.T) {
	if !(CatalogView{}).Minimize() {
		t.Fatal("unauthenticated must minimize")
	}
	if !(CatalogView{Authenticated: true, EmbedBound: true}).Minimize() {
		t.Fatal("capability-less embed session must minimize")
	}
	if (CatalogView{Authenticated: true, EmbedBound: true, Capabilities: []string{authz.PermWorkflowView}}).Minimize() {
		t.Fatal("embed session with caps is the product catalog")
	}
	if (CatalogView{Authenticated: true}).Minimize() {
		t.Fatal("standalone authenticated keeps fuller product disclosure")
	}
}

func TestNewCatalogForHidesMembershipIsolationWithoutGrant(t *testing.T) {
	public := NewCatalogFor([]string{"https://portal.example"}, []string{"https://idp.example"}, CatalogView{})
	if CatalogDisclosesMembershipIsolation(public) {
		t.Fatal("public catalog leaked membership/isolation")
	}
	if !public.Rules.MembershipIsolationRequiresGrant || public.Rules.MembershipIsolationGranted {
		t.Fatalf("public grant flags %+v", public.Rules)
	}
	if len(public.FrameAncestors) != 1 || public.FrameAncestors[0] != "https://portal.example" {
		t.Fatalf("ADV-011 frameAncestors must stay published: %v", public.FrameAncestors)
	}
	if len(public.Issuers) != 1 || public.Issuers[0] != "https://idp.example" {
		t.Fatalf("ADV-023 issuers must stay published: %v", public.Issuers)
	}
	if !public.Rules.ChromeFromSession || !public.Rules.SharedHostAllowlist || !public.Rules.EmbedSessionsCannotBootstrap {
		t.Fatalf("essentials rules %+v", public.Rules)
	}
	if len(public.Capabilities) != 0 {
		t.Fatalf("minimized capabilities %v", public.Capabilities)
	}
	if len(public.Routes) != 1 || public.Routes[0].ID != "home" {
		t.Fatalf("minimized routes %+v", public.Routes)
	}
	for _, r := range public.API {
		if !slices.Contains(EssentialAPIPaths, r.Path) {
			t.Fatalf("minimized catalog included %s", r.Path)
		}
	}
	for _, h := range public.Hooks {
		if !slices.Contains(EssentialHookIDs, h.ID) {
			t.Fatalf("minimized catalog included hook %s", h.ID)
		}
	}

	viewer := NewCatalogFor(nil, nil, CatalogView{
		Authenticated: true,
		EmbedBound:    true,
		Capabilities:  []string{authz.PermWorkflowView},
	})
	if CatalogDisclosesMembershipIsolation(viewer) {
		t.Fatal("viewer embed catalog leaked membership/isolation")
	}
	if viewer.Rules.MembershipIsolationGranted {
		t.Fatal("viewer must not be granted")
	}
	foundWorkflow := false
	for _, r := range viewer.Routes {
		if r.ID == "workflow" {
			foundWorkflow = true
		}
		if IsMembershipIsolationRoute(r.ID) {
			t.Fatalf("viewer route %s", r.ID)
		}
	}
	if !foundWorkflow {
		t.Fatal("authenticated embed catalog must keep product routes")
	}
	if slices.Contains(viewer.Capabilities, authz.PermWorkspaceAdminister) || slices.Contains(viewer.Capabilities, authz.PermPlatformAdminister) {
		t.Fatalf("viewer capabilities leaked admin: %v", viewer.Capabilities)
	}

	granted := NewCatalogFor(nil, nil, CatalogView{
		Authenticated: true,
		EmbedBound:    true,
		Capabilities:  []string{authz.PermWorkspaceAdminister},
	})
	if !CatalogDisclosesMembershipIsolation(granted) || !granted.Rules.MembershipIsolationGranted {
		t.Fatal("granted catalog must include membership/isolation")
	}
	foundMembership, foundIsolation := false, false
	for _, r := range granted.Routes {
		if r.ID == RouteIDMembership {
			foundMembership = true
		}
		if r.ID == RouteIDIsolation {
			foundIsolation = true
		}
	}
	if !foundMembership || !foundIsolation {
		t.Fatalf("granted routes missing membership/isolation: %+v", granted.Routes)
	}
	if !slices.Contains(granted.Capabilities, authz.PermWorkspaceAdminister) {
		t.Fatal("granted catalog must list workspace.administer")
	}

	for _, c := range []Catalog{public, viewer, granted} {
		for _, leak := range c.KeyManagement.PrivateNever {
			if leak == "" {
				t.Fatal("privateNever must stay populated")
			}
		}
		if !slices.Contains(c.KeyManagement.PrivateNever, "d") || !slices.Contains(c.KeyManagement.PrivateNever, "EMBED_SIGNING_KEY") {
			t.Fatalf("secrets list %+v", c.KeyManagement.PrivateNever)
		}
	}
}
