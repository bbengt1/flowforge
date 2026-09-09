package portal

import (
	"slices"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
)

func TestCapabilityMapCoversPortalRoles(t *testing.T) {
	m := CapabilityMap()
	if len(m) != 6 {
		t.Fatalf("bindings = %d", len(m))
	}
	byRole := map[string]RoleBinding{}
	for _, b := range m {
		byRole[b.PortalRole] = b
		if len(b.Capabilities) == 0 {
			t.Fatalf("%s has no capabilities", b.PortalRole)
		}
		for _, c := range b.Capabilities {
			if !authz.Known(c) {
				t.Fatalf("%s maps unknown capability %s", b.PortalRole, c)
			}
		}
	}
	if !slices.Contains(byRole[RoleViewer].Capabilities, authz.PermWorkflowView) {
		t.Fatal("viewer must include workflow.view")
	}
	if slices.Contains(byRole[RoleViewer].Capabilities, authz.PermWorkspaceAdminister) {
		t.Fatal("viewer must not administer")
	}
	if !slices.Contains(byRole[RoleOperator].Capabilities, authz.PermWorkflowExecute) {
		t.Fatal("operator must execute")
	}
	if slices.Contains(byRole[RoleOperator].Capabilities, authz.PermWorkspaceAdminister) {
		t.Fatal("operator must not administer")
	}
	if !slices.Contains(byRole[RoleAdmin].Capabilities, authz.PermWorkspaceAdminister) {
		t.Fatal("admin must administer")
	}
	if slices.Contains(byRole[RoleAdmin].Capabilities, authz.PermPlatformAdminister) {
		t.Fatal("portal admin must not receive platform.administer")
	}
}

func TestMapRolesAliasesAndUnknownFailClosed(t *testing.T) {
	caps, err := MapRoles([]string{"operator"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(caps, authz.PermWorkflowExecute) {
		t.Fatalf("operator alias: %v", caps)
	}
	if _, err := MapRoles([]string{"portal.operator", "hostile.root"}); err != ErrUnknownRole {
		t.Fatalf("unknown role: %v", err)
	}
	if _, err := MapRoles(nil); err != ErrRoleRequired {
		t.Fatalf("empty: %v", err)
	}
	if _, err := UnionCapabilities(nil, []string{"not.a.permission"}); err != ErrUnknownCapability {
		t.Fatalf("unknown cap: %v", err)
	}
	if _, err := UnionCapabilities([]string{RoleAdmin}, []string{authz.PermPlatformAdminister}); err != ErrPlatformCapability {
		t.Fatalf("platform.administer extra: %v", err)
	}
	if _, err := UnionCapabilities(nil, []string{authz.PermPlatformAdminister}); err != ErrPlatformCapability {
		t.Fatalf("platform.administer only: %v", err)
	}
}

func TestIssuerAllowlistFailsClosed(t *testing.T) {
	allow := ParseIssuers("https://portal.cp-ops.example, https://portal.cp-ops.example", "")
	if len(allow) != 1 || allow[0] != "https://portal.cp-ops.example" {
		t.Fatalf("allow %v", allow)
	}
	if IssuerAllowed("https://hostile.example", allow) {
		t.Fatal("hostile issuer allowed")
	}
	if !IssuerAllowed("https://portal.cp-ops.example", allow) {
		t.Fatal("portal issuer denied")
	}
	if IssuerAllowed("", allow) {
		t.Fatal("empty issuer allowed")
	}
	if IssuerAllowed("https://portal.cp-ops.example", nil) {
		t.Fatal("empty allowlist must fail closed")
	}
	if IssuerAllowed("https://portal.cp-ops.example", []string{}) {
		t.Fatal("empty slice must fail closed")
	}
}

func TestParseFrameAncestorsRejectsWildcards(t *testing.T) {
	got := ParseFrameAncestors("https://portal.example * null http://localhost:3000")
	if len(got) != 2 || got[0] != "https://portal.example" || got[1] != "http://localhost:3000" {
		t.Fatalf("frames %v", got)
	}
	if len(ParseFrameAncestors("*")) != 0 {
		t.Fatal("wildcard accepted")
	}
}

func TestPrepareMintUsesEmbedAudienceAndPortalIssuer(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	in, caps, err := PrepareMint(MintRequest{
		PortalRoles: []string{RoleViewer},
		Issuer:      "https://portal.cp-ops.example",
		Subject:     "portal-user-1",
	}, "https://portal.cp-ops.example", "svc-portal", "Portal", "11111111-1111-4111-8111-111111111111", "ops", "22222222-2222-4222-8222-222222222222",
		[]string{"https://portal.cp-ops.example"}, now)
	if err != nil {
		t.Fatal(err)
	}
	if in.Audience != embed.DefaultAudience {
		t.Fatalf("audience %q", in.Audience)
	}
	if in.Issuer != "https://portal.cp-ops.example" {
		t.Fatalf("issuer %q", in.Issuer)
	}
	if in.Subject != "portal-user-1" {
		t.Fatalf("subject %q", in.Subject)
	}
	if !slices.Contains(caps, authz.PermWorkflowView) {
		t.Fatalf("caps %v", caps)
	}
	if in.Host != "https://portal.cp-ops.example" || in.WorkbenchKey != "ops" {
		t.Fatalf("mint input %+v", in)
	}
}

func TestPrepareMintEmptyAllowlistFailsClosed(t *testing.T) {
	_, _, err := PrepareMint(MintRequest{
		PortalRoles: []string{RoleViewer},
		Issuer:      "https://portal.cp-ops.example",
	}, "https://portal.cp-ops.example", "svc-portal", "Portal", "11111111-1111-4111-8111-111111111111", "ops", "",
		nil, time.Now().UTC())
	if err != ErrIssuer {
		t.Fatalf("empty allowlist: %v", err)
	}
}

func TestPrepareMintHostileIssuer(t *testing.T) {
	_, _, err := PrepareMint(MintRequest{
		PortalRoles: []string{RoleViewer},
		Issuer:      "https://hostile.example",
	}, "https://hostile.example", "bad", "", "11111111-1111-4111-8111-111111111111", "ops", "",
		[]string{"https://portal.cp-ops.example"}, time.Now().UTC())
	if err != ErrIssuer {
		t.Fatalf("hostile issuer: %v", err)
	}
}

func TestCatalogBoundaryNeverShares(t *testing.T) {
	c := NewCatalog([]string{"https://portal.cp-ops.example"}, []string{"https://portal.example"})
	if c.Adapter != AdapterVersion || c.SDK != embed.SDKVersion {
		t.Fatalf("versions %+v", c)
	}
	if c.Boundary.SharesDatabase || c.Boundary.SharesExecutor || c.Boundary.ParallelAuthPath {
		t.Fatalf("boundary %+v", c.Boundary)
	}
	if !c.Rules.EmbedSessionsCannotBootstrap || !c.Rules.PortalAdminIsNotPlatformAdmin {
		t.Fatalf("bootstrap rules %+v", c.Rules)
	}
	if c.Boundary.PortalEntryIsAuthorization || c.Boundary.HostTenantIsAuthorization {
		t.Fatal("entry/host must not authorize")
	}
	if !c.Boundary.UsesEmbedMint || !c.Boundary.UsesEmbedExchange {
		t.Fatal("must reuse embed mint/exchange")
	}
	if !c.Rules.NoCredentialOrRawLogLeak || !c.Rules.NoDatabaseShare {
		t.Fatalf("rules %+v", c.Rules)
	}
	if c.MountPrefix != "/embed/v1" {
		t.Fatalf("mount %s", c.MountPrefix)
	}
	if len(c.Wiring) < 5 {
		t.Fatalf("wiring %d", len(c.Wiring))
	}
	foundMint, foundExchange := false, false
	for _, step := range c.Wiring {
		if step.ID == "mint" && step.Path == "/api/v1/portal/adapter/assertions" {
			foundMint = true
		}
		if step.ID == "exchange" && step.Path == "/api/v1/embed/exchange" {
			foundExchange = true
		}
	}
	if !foundMint || !foundExchange {
		t.Fatal("host wiring missing mint/exchange")
	}
}

func TestHostWiringDoesNotShareDatabase(t *testing.T) {
	entry := HostWiring()[0]
	if entry.ID != "entry" {
		t.Fatalf("first step %s", entry.ID)
	}
	if entry.Note == "" {
		t.Fatal("entry note must document the Portal/FlowForge split")
	}
	b := DefaultBoundary()
	if b.SharesDatabase || b.SharesExecutor {
		t.Fatal(ErrSharesBoundary)
	}
}
