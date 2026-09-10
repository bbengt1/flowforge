package embed

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
)

func testMintInput(now time.Time) MintInput {
	return MintInput{
		Issuer:       "https://portal.example",
		Subject:      "operator-1",
		DisplayName:  "Ada",
		Host:         "https://portal.example",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		WorkspaceID:  "22222222-2222-2222-2222-222222222222",
		Capabilities: []string{"workflow.view", "execution.view"},
		TTL:          DefaultTTL,
		Audience:     DefaultAudience,
		Now:          now,
	}
}

func TestMintHappyPath(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	minted, claims, err := Mint(m, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	if minted.Assertion == "" || minted.TokenID == "" {
		t.Fatalf("missing assertion or jti: %+v", minted)
	}
	if minted.SDK != SDKVersion || minted.Audience != DefaultAudience {
		t.Fatalf("sdk/aud: %+v", minted)
	}
	if minted.Algorithm != Algorithm || minted.KeyID != m.KeyID {
		t.Fatalf("alg/kid: %+v", minted)
	}
	if claims.NotBefore != now.Unix() || claims.ExpiresAt != now.Add(DefaultTTL).Unix() {
		t.Fatalf("time bounds %+v", claims)
	}
	got, err := Verify(m, minted.Assertion, VerifyOptions{
		Audience:       DefaultAudience,
		Now:            now.Add(time.Second),
		Consumer:       NewMemoryJTI(),
		ResolvedWS:     claims.WorkspaceID,
		AllowedIssuers: []string{claims.Issuer},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Claims.TokenID != claims.TokenID || got.Claims.Subject != "operator-1" {
		t.Fatalf("verified %+v", got.Claims)
	}
}

func TestMintRejectsWrongAudienceAndBadTTL(t *testing.T) {
	m := TestMaterial()
	in := testMintInput(time.Now().UTC())
	in.Audience = "someone-else"
	if _, _, err := Mint(m, in); err != ErrAudience {
		t.Fatalf("wrong aud: %v", err)
	}
	in = testMintInput(time.Now().UTC())
	in.TTL = time.Hour
	if _, _, err := Mint(m, in); err != ErrTTL {
		t.Fatalf("long ttl: %v", err)
	}
	in = testMintInput(time.Now().UTC())
	in.Capabilities = []string{"not.a.permission"}
	if _, _, err := Mint(m, in); err != ErrCapability {
		t.Fatalf("unknown cap: %v", err)
	}
	in = testMintInput(time.Now().UTC())
	in.Capabilities = []string{authz.PermPlatformAdminister}
	if _, _, err := Mint(m, in); err != ErrCapability {
		t.Fatalf("platform.administer: %v", err)
	}
	in = testMintInput(time.Now().UTC())
	in.Capabilities = []string{authz.PermEmbedImpersonate}
	if _, _, err := Mint(m, in); err != ErrCapability {
		t.Fatalf("embed.impersonate: %v", err)
	}
}

func TestVerifyMissingClaims(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	base := Claims{
		Issuer:       "https://portal.example",
		Audience:     DefaultAudience,
		Subject:      "operator-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(DefaultTTL).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          SDKVersion,
	}
	cases := []struct {
		name string
		mut  func(*Claims)
	}{
		{"iss", func(c *Claims) { c.Issuer = "" }},
		{"aud", func(c *Claims) { c.Audience = "" }},
		{"sub", func(c *Claims) { c.Subject = "" }},
		{"nbf", func(c *Claims) { c.NotBefore = 0 }},
		{"exp", func(c *Claims) { c.ExpiresAt = 0 }},
		{"jti", func(c *Claims) { c.TokenID = "" }},
		{"tenant_id", func(c *Claims) { c.TenantID = "" }},
		{"workbench_key", func(c *Claims) { c.WorkbenchKey = "" }},
		{"capabilities", func(c *Claims) { c.Capabilities = nil }},
		{"sdk", func(c *Claims) { c.SDK = "" }},
	}
	for _, tc := range cases {
		c := base
		tc.mut(&c)
		token := mustSignRaw(t, m, c)
		_, err := Verify(m, token, VerifyOptions{Now: now.Add(time.Second), SkipJTI: true, AllowedIssuers: []string{"https://portal.example"}})
		if err != ErrMissingClaim && err != ErrSDK && err != ErrCapability {
			t.Fatalf("%s: err=%v", tc.name, err)
		}
	}
}

func TestVerifyWrongAudience(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	c := Claims{
		Issuer:       "https://portal.example",
		Audience:     "other-product",
		Subject:      "operator-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(DefaultTTL).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          SDKVersion,
	}
	token := mustSignRaw(t, m, c)
	_, err := Verify(m, token, VerifyOptions{Now: now.Add(time.Second), SkipJTI: true})
	if err != ErrAudience {
		t.Fatalf("err=%v", err)
	}
}

func TestVerifyExpiredAndNBF(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	c := Claims{
		Issuer:       "https://portal.example",
		Audience:     DefaultAudience,
		Subject:      "operator-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(30 * time.Second).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          SDKVersion,
	}
	token := mustSignRaw(t, m, c)
	if _, err := Verify(m, token, VerifyOptions{Now: now.Add(31 * time.Second), SkipJTI: true, AllowedIssuers: []string{c.Issuer}}); err != ErrExpired {
		t.Fatalf("expired: %v", err)
	}
	if _, err := Verify(m, token, VerifyOptions{Now: now.Add(-time.Second), SkipJTI: true, AllowedIssuers: []string{c.Issuer}}); err != ErrNotYetValid {
		t.Fatalf("nbf: %v", err)
	}
}

func TestVerifySucceedsBeforeWorkspaceBind(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	minted, claims, err := Mint(m, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	jti := NewMemoryJTI()
	got, err := Verify(m, minted.Assertion, VerifyOptions{
		Audience:       DefaultAudience,
		Now:            now.Add(time.Second),
		Consumer:       jti,
		AllowedIssuers: []string{claims.Issuer},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Claims.WorkspaceID != claims.WorkspaceID {
		t.Fatalf("workspace claim %q", got.Claims.WorkspaceID)
	}
	if err := BindVerifiedWorkspace(claims.WorkspaceID, got.Claims); err != nil {
		t.Fatal(err)
	}
	if err := BindVerifiedWorkspace("33333333-3333-3333-3333-333333333333", got.Claims); err != ErrWorkspaceBinding {
		t.Fatalf("mismatch bind: %v", err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{
		Audience:       DefaultAudience,
		Now:            now.Add(time.Second),
		Consumer:       jti,
		AllowedIssuers: []string{claims.Issuer},
	}); err != ErrReplay {
		t.Fatalf("jti must consume after verify success: %v", err)
	}
}

func TestVerifyForgedDoesNotConsumeJTI(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	minted, claims, err := Mint(m, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	forged := minted.Assertion
	if len(forged) < 4 {
		t.Fatal("token too short")
	}
	forged = forged[:len(forged)-2] + "xx"
	jti := NewMemoryJTI()
	if _, err := Verify(m, forged, VerifyOptions{
		Now: now.Add(time.Second), Consumer: jti, AllowedIssuers: []string{claims.Issuer},
	}); err != ErrSignature {
		t.Fatalf("forged: %v", err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), Consumer: jti, AllowedIssuers: []string{claims.Issuer},
	}); err != nil {
		t.Fatalf("valid after forged must still consume: %v", err)
	}
}

func TestJTIReplayRejected(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	minted, _, err := Mint(m, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	jti := NewMemoryJTI()
	opt := VerifyOptions{Now: now.Add(time.Second), Consumer: jti, ResolvedWS: "22222222-2222-2222-2222-222222222222", AllowedIssuers: []string{"https://portal.example"}}
	if _, err := Verify(m, minted.Assertion, opt); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(m, minted.Assertion, opt); err != ErrReplay {
		t.Fatalf("replay: %v", err)
	}
}

func TestJWKSNeverReturnsPrivateKeys(t *testing.T) {
	m := TestMaterial()
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, leak := range []string{
		"BEGIN", "private", "\"d\"", EncodeSeedB64(m.Private),
		base64.RawURLEncoding.EncodeToString(m.Private),
		string(m.Private),
	} {
		if leak != "" && strings.Contains(body, leak) {
			t.Fatalf("private material %q leaked: %s", leak, body)
		}
	}
	jwks := m.PublicJWKS()
	if len(jwks.Keys) != 1 || jwks.Keys[0].X == "" || !jwks.SigningReady {
		t.Fatalf("jwks %+v", jwks)
	}
	if jwks.Keys[0].Kty != KeyType || jwks.Keys[0].Crv != Curve {
		t.Fatalf("jwk %+v", jwks.Keys[0])
	}
}

func TestCatalogDocumentsContractAndHooks(t *testing.T) {
	c := NewCatalog(nil)
	if c.SDK != SDKVersion || c.Audience != DefaultAudience {
		t.Fatalf("catalog %+v", c)
	}
	if len(c.Routes) == 0 || c.MountPrefix != MountPrefix {
		t.Fatal("routes")
	}
	if EmbedPath("/workflows/{id}") != "/embed/v1/workflows/{id}" {
		t.Fatal(EmbedPath("/workflows/{id}"))
	}
	if !c.Rules.AssertionNotInURL || !c.Rules.AudienceBound || !c.Rules.EmbedSessionsCannotBootstrap || !c.Rules.PartitionedEmbedCookies || !c.Rules.VerifyBeforeWorkspaceLookup || !c.Rules.JTIRetainPastExpiry || !c.Rules.AuthzAudited || !c.Rules.ExchangeRateLimited || !c.Rules.SharedHostAllowlist || !c.Rules.EmptyHostAllowlistFailsClosed || !c.Rules.PostMessageUsesFrameAncestors {
		t.Fatal("rules")
	}
	if c.FrameAncestors != nil {
		t.Fatalf("empty allowlist must publish nil/empty frameAncestors, got %v", c.FrameAncestors)
	}
	listed := NewCatalog([]string{"https://portal.example", "'self'"})
	if len(listed.FrameAncestors) != 2 || listed.FrameAncestors[0] != "https://portal.example" || listed.FrameAncestors[1] != "'self'" {
		t.Fatalf("published frames %v", listed.FrameAncestors)
	}
	if c.JTIRetention != JTIRetention.String() {
		t.Fatalf("jtiRetention %q", c.JTIRetention)
	}
	foundRotate, foundMint, foundExchange := false, false, false
	for _, r := range c.API {
		if r.Path == "/api/v1/embed/assertions" {
			foundMint = true
			if !strings.Contains(r.Note, "embed.impersonate") || !strings.Contains(r.Note, "subset of the caller") {
				t.Fatalf("mint note %q", r.Note)
			}
		}
		if r.Path == "/api/v1/embed/keys/rotate" {
			foundRotate = true
			if !strings.Contains(r.Auth, "platform.administer") || strings.Contains(r.Auth, "workspace.administer") {
				t.Fatalf("rotate auth %q", r.Auth)
			}
		}
		if r.Path == "/api/v1/embed/exchange" {
			foundExchange = true
			if !strings.Contains(r.Note, "Partitioned") || !strings.Contains(r.Note, "SameSite=None") {
				t.Fatalf("exchange note %q", r.Note)
			}
			if !strings.Contains(r.Note, "before any workspace lookup") {
				t.Fatalf("exchange note must require verify before workspace lookup: %q", r.Note)
			}
			if !strings.Contains(r.Note, "429") || !strings.Contains(r.Note, "rate-limited") {
				t.Fatalf("exchange note must document 429 rate-limit: %q", r.Note)
			}
		}
	}
	if !foundRotate {
		t.Fatal("catalog missing rotate route")
	}
	if !foundMint {
		t.Fatal("catalog missing mint route")
	}
	if !foundExchange {
		t.Fatal("catalog missing exchange route")
	}
	if DeniesBootstrap(false) {
		t.Fatal("unbound session must allow the trusted bootstrap path")
	}
	if !DeniesBootstrap(true) {
		t.Fatal("bound embed session must deny tenant/workspace bootstrap")
	}
	if len(c.Hooks) < 3 {
		t.Fatal("expected E11.2 hooks")
	}
	foundCHIPS, foundVerifyFirst, foundJTI, foundAudit, foundRate, foundAllowlist := false, false, false, false, false, false
	for _, h := range c.Hooks {
		if h.Status != "ready" {
			t.Fatalf("hook %s status %s", h.ID, h.Status)
		}
		if h.ID == "chips.embed-cookies" {
			foundCHIPS = true
			if !strings.Contains(h.Note, "Partitioned") {
				t.Fatalf("chips hook %q", h.Note)
			}
		}
		if h.ID == "assertion.verify-before-lookup" {
			foundVerifyFirst = true
			if !strings.Contains(h.Note, "before any workspace") {
				t.Fatalf("verify-before-lookup hook %q", h.Note)
			}
		}
		if h.ID == "jti.consume" {
			foundJTI = true
			if !strings.Contains(h.Note, "RETURNING") || !strings.Contains(h.Note, "24h") || !strings.Contains(h.Note, "retain_until") {
				t.Fatalf("jti.consume hook %q", h.Note)
			}
		}
		if h.ID == "authz.audit" {
			foundAudit = true
			if !strings.Contains(h.Note, "secret-free") && !strings.Contains(h.Fail, "secret-free") {
				t.Fatalf("authz.audit hook %q", h.Note)
			}
		}
		if h.ID == "exchange.rate-limit" {
			foundRate = true
			if !strings.Contains(h.Fail, "429") {
				t.Fatalf("exchange.rate-limit hook %q", h.Fail)
			}
		}
		if h.ID == "host.allowlist" {
			foundAllowlist = true
			if !strings.Contains(h.Note, "frameAncestors") || !strings.Contains(h.Fail, "fails closed") {
				t.Fatalf("host.allowlist hook %q %q", h.Note, h.Fail)
			}
		}
	}
	if !foundCHIPS {
		t.Fatal("catalog missing chips.embed-cookies hook")
	}
	if !foundVerifyFirst {
		t.Fatal("catalog missing assertion.verify-before-lookup hook")
	}
	if !foundJTI {
		t.Fatal("catalog missing jti.consume hook")
	}
	if !foundAudit {
		t.Fatal("catalog missing authz.audit hook")
	}
	if !foundRate {
		t.Fatal("catalog missing exchange.rate-limit hook")
	}
	if !foundAllowlist {
		t.Fatal("catalog missing host.allowlist hook")
	}
}

func TestLogsNeverIncludeAssertionOrPrivateKey(t *testing.T) {
	m := TestMaterial()
	now := time.Now().UTC()
	minted, _, err := Mint(m, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	log.Info("embed_mint",
		"jti", minted.TokenID,
		"kid", minted.KeyID,
		"assertion", minted.Assertion,
		"token", minted.Assertion,
		"private_key", EncodeSeedB64(m.Private),
	)
	out := buf.String()
	if strings.Contains(out, minted.Assertion) {
		t.Fatal("assertion leaked into logs")
	}
	if strings.Contains(out, EncodeSeedB64(m.Private)) {
		t.Fatal("private key leaked into logs")
	}
	if !strings.Contains(out, minted.TokenID) {
		t.Fatal("jti should remain for correlation")
	}
}

func TestBadSignatureRejected(t *testing.T) {
	m := TestMaterial()
	otherPub, otherPriv, _ := ed25519.GenerateKey(nil)
	other := Material{KeyID: m.KeyID, Private: otherPriv, Public: otherPub, Status: KeyStatusActive}
	now := time.Now().UTC()
	minted, _, err := Mint(other, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{Now: now.Add(time.Second), SkipJTI: true}); err != ErrSignature {
		t.Fatalf("err=%v", err)
	}
}

func TestTenancyAndRotationHooksFailClosed(t *testing.T) {
	if err := TenancyPropagationHook(); err != nil {
		t.Fatalf("tenancy hook should be enabled: %v", err)
	}
	m := TestMaterial()
	if err := RotationHook(m, "unknown-kid"); err != ErrUnknownKey {
		t.Fatalf("rotation: %v", err)
	}
	if err := RotationHook(m, m.KeyID); err != nil {
		t.Fatal(err)
	}
	overlap := overlapMaterial(t)
	if err := RotationHook(overlap, overlap.Overlap[0].Kid); err != nil {
		t.Fatal(err)
	}
}

func TestAddOverlapLockedToActiveKey(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	until := now.Add(2 * time.Minute)
	old := TestMaterial()
	ring := NewRing(old, NewMemoryKeys())
	foreign := NewEphemeralMaterial()
	foreign.KeyID = "attacker-kid"
	err := ring.AddOverlap(ctx, PublicJWK{
		Kty: KeyType, Crv: Curve, X: encodePublicX(foreign.Public), Kid: foreign.KeyID,
		Use: "sig", Alg: Algorithm,
	}, until, now)
	if err != ErrOverlapNotPrior {
		t.Fatalf("foreign key: %v", err)
	}

	active := old.PublicJWKS().Keys[0]
	if err := ring.AddOverlap(ctx, active, until, now); err != nil {
		t.Fatalf("prior active: %v", err)
	}
	next := NewEphemeralMaterial()
	next.KeyID = "next-active"
	if err := ring.InstallActive(next); err != nil {
		t.Fatal(err)
	}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(ring.MaterialAt(now.Add(time.Second)), minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyID != old.KeyID {
		t.Fatalf("kid %s", got.KeyID)
	}

	wrongX := active
	wrongX.X = encodePublicX(foreign.Public)
	if err := ring.AddOverlap(ctx, wrongX, until, now); err != ErrOverlapNotPrior {
		t.Fatalf("kid reuse with foreign x: %v", err)
	}
	if err := ring.AddOverlap(ctx, PublicJWK{
		Kty: KeyType, Crv: Curve, X: encodePublicX(foreign.Public), Kid: old.KeyID,
		Use: "sig", Alg: Algorithm,
	}, until, now); err != ErrOverlapNotPrior {
		t.Fatalf("old kid with foreign x after handoff: %v", err)
	}
}

func TestVerifyRejectsExpiredOverlapAndAcceptsUntilExpiry(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := TestMaterial()
	old.KeyID = "prior-active"
	until := now.Add(2 * time.Minute)
	active := NewEphemeralMaterial()
	active.KeyID = "next-active"
	active.Overlap = []PublicJWK{{
		Kty: KeyType, Crv: Curve, X: encodePublicX(old.Public), Kid: old.KeyID,
		Use: "sig", Alg: Algorithm, Status: KeyStatusOverlap, OverlapUntil: until,
	}}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	}
	if _, err := Verify(active, minted.Assertion, opt); err != nil {
		t.Fatalf("valid overlap: %v", err)
	}
	opt.Now = until
	if _, err := Verify(active, minted.Assertion, opt); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("overlapUntil inclusive end: %v", err)
	}
	opt.Now = until.Add(time.Second)
	if _, err := Verify(active, minted.Assertion, opt); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("expired overlap: %v", err)
	}
}

func TestRotateOverlapExpiresAfterOverlapUntil(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := TestMaterial()
	old.KeyID = "rotate-old"
	store := NewMemoryKeys()
	ring := NewRing(old, store)
	until := now.Add(90 * time.Second)
	if err := ring.AddOverlap(ctx, old.PublicJWKS().Keys[0], until, now); err != nil {
		t.Fatal(err)
	}
	next := NewEphemeralMaterial()
	next.KeyID = "rotate-new"
	if err := ring.InstallActive(next); err != nil {
		t.Fatal(err)
	}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	}
	if _, err := ring.Verify(ctx, minted.Assertion, opt); err != nil {
		t.Fatalf("prior key during overlap: %v", err)
	}
	opt.Now = until.Add(time.Second)
	if _, err := ring.Verify(ctx, minted.Assertion, opt); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("prior key after overlapUntil: %v", err)
	}
}

func TestVerifyRefreshesOverlapFromSharedStore(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := TestMaterial()
	old.KeyID = "shared-old"
	next := NewEphemeralMaterial()
	next.KeyID = "shared-new"
	store := NewMemoryKeys()
	writer := NewRing(old, store)
	reader := NewRing(next, store)
	if err := writer.AddOverlap(ctx, old.PublicJWKS().Keys[0], now.Add(2*time.Minute), now); err != nil {
		t.Fatal(err)
	}
	if err := writer.InstallActive(next); err != nil {
		t.Fatal(err)
	}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	}
	if _, err := Verify(reader.MaterialAt(opt.Now), minted.Assertion, opt); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("stale reader without refresh must miss overlap: %v", err)
	}
	if _, err := reader.Verify(ctx, minted.Assertion, opt); err != nil {
		t.Fatalf("verify-path refresh must load overlap: %v", err)
	}

	if err := writer.RetireOverlap(ctx, old.KeyID); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Verify(ctx, minted.Assertion, opt); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("verify-path refresh must drop retired overlap: %v", err)
	}
}

func TestVerifyOverlapKeyAcceptedUnknownKidRejected(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := TestMaterial()
	old.KeyID = "old-kid"
	active := NewEphemeralMaterial()
	active.KeyID = "active-kid"
	active.Overlap = []PublicJWK{{
		Kty: KeyType, Crv: Curve, X: encodePublicX(old.Public), Kid: old.KeyID,
		Use: "sig", Alg: Algorithm, Status: KeyStatusOverlap, OverlapUntil: now.Add(2 * time.Minute),
	}}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(active, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyID != old.KeyID {
		t.Fatalf("kid %s", got.KeyID)
	}

	foreign := NewEphemeralMaterial()
	foreign.KeyID = "foreign"
	other, _, err := Mint(foreign, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(active, other.Assertion, VerifyOptions{Now: now.Add(time.Second), SkipJTI: true}); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("unknown kid: %v", err)
	}
}

func TestVerifyRefusesOverlapKeyWithoutExpiry(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	old := TestMaterial()
	old.KeyID = "no-until-old"
	active := NewEphemeralMaterial()
	active.KeyID = "no-until-active"
	active.Overlap = []PublicJWK{{
		Kty: KeyType, Crv: Curve, X: encodePublicX(old.Public), Kid: old.KeyID,
		Use: "sig", Alg: Algorithm, Status: KeyStatusOverlap,
	}}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	opt := VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	}
	if _, err := Verify(active, minted.Assertion, opt); err != ErrSignature && err != ErrUnknownKey {
		t.Fatalf("missing overlapUntil must not verify forever: %v", err)
	}
	active.Overlap[0].OverlapUntil = now.Add(2 * time.Minute)
	if _, err := Verify(active, minted.Assertion, opt); err != nil {
		t.Fatalf("short overlapUntil must verify: %v", err)
	}
}

func TestIssuerAllowlistFailsClosed(t *testing.T) {
	m := TestMaterial()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	minted, _, err := Mint(m, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://other.example"},
	}); err != ErrIssuerNotAllowed {
		t.Fatalf("unknown issuer: %v", err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
	}); err != ErrIssuerNotAllowed {
		t.Fatalf("empty allowlist: %v", err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{},
	}); err != ErrIssuerNotAllowed {
		t.Fatalf("empty slice: %v", err)
	}
	if _, err := Verify(m, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
		AllowedIssuers: []string{"https://portal.example"},
	}); err != nil {
		t.Fatal(err)
	}
}

func TestPropagateTenancyRejectsHostTenantAlone(t *testing.T) {
	bound := SessionTenancy{
		TenantID:     "11111111-1111-1111-1111-111111111111",
		WorkbenchKey: "ops",
		WorkspaceID:  "22222222-2222-2222-2222-222222222222",
		Capabilities: []string{"workflow.view"},
	}
	if _, err := PropagateTenancy(bound, authz.WorkspaceClaim{TenantID: bound.TenantID}); err != nil {
		t.Fatal(err)
	}
	if _, err := PropagateTenancy(bound, authz.WorkspaceClaim{
		TenantID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", WorkbenchKey: "ops",
	}); err != ErrTenancyMismatch {
		t.Fatalf("cross-tenant: %v", err)
	}
	if _, err := PropagateTenancy(bound, authz.WorkspaceClaim{
		TenantID: bound.TenantID, WorkbenchKey: "other",
	}); err != ErrTenancyMismatch {
		t.Fatalf("cross-workbench: %v", err)
	}
	if _, err := PropagateTenancy(bound, authz.WorkspaceClaim{TenantSlug: "acme"}); err != ErrTenancyMismatch {
		t.Fatalf("tenant slug alone: %v", err)
	}
	if _, err := PropagateTenancy(SessionTenancy{}, authz.WorkspaceClaim{TenantID: bound.TenantID, WorkbenchKey: "ops"}); err != ErrTenancyUnready {
		t.Fatalf("unbound: %v", err)
	}
}

func TestJTIConsumeRace(t *testing.T) {
	jti := NewMemoryJTI()
	id := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	exp := time.Now().UTC().Add(time.Minute)
	errs := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			errs <- jti.Consume(context.Background(), id, exp)
		}()
	}
	var ok, replay int
	for i := 0; i < 2; i++ {
		err := <-errs
		switch err {
		case nil:
			ok++
		case ErrReplay:
			replay++
		default:
			t.Fatalf("unexpected %v", err)
		}
	}
	if ok != 1 || replay != 1 {
		t.Fatalf("ok=%d replay=%d", ok, replay)
	}
}

func overlapMaterial(t *testing.T) Material {
	t.Helper()
	old := NewEphemeralMaterial()
	old.KeyID = "overlap-kid"
	m := TestMaterial()
	m.Overlap = []PublicJWK{{
		Kty: KeyType, Crv: Curve, X: encodePublicX(old.Public), Kid: old.KeyID,
		Use: "sig", Alg: Algorithm, Status: KeyStatusOverlap,
		OverlapUntil: time.Now().UTC().Add(2 * time.Minute),
	}}
	return m
}

func encodePublicX(pub ed25519.PublicKey) string {
	return base64.RawURLEncoding.EncodeToString(pub)
}

func mustSignRaw(t *testing.T, m Material, c Claims) string {
	t.Helper()
	h := header{Alg: Algorithm, Typ: TokenType, Kid: m.KeyID, SDK: SDKVersion}
	hb, err := json.Marshal(h)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	input := b64(hb) + "." + b64(pb)
	sig := ed25519.Sign(m.Private, []byte(input))
	return input + "." + b64(sig)
}
