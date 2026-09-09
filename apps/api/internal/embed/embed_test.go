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
		Audience:   DefaultAudience,
		Now:        now.Add(time.Second),
		Consumer:   NewMemoryJTI(),
		ResolvedWS: claims.WorkspaceID,
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
		_, err := Verify(m, token, VerifyOptions{Now: now.Add(time.Second), SkipJTI: true})
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
	if _, err := Verify(m, token, VerifyOptions{Now: now.Add(31 * time.Second), SkipJTI: true}); err != ErrExpired {
		t.Fatalf("expired: %v", err)
	}
	if _, err := Verify(m, token, VerifyOptions{Now: now.Add(-time.Second), SkipJTI: true}); err != ErrNotYetValid {
		t.Fatalf("nbf: %v", err)
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
	opt := VerifyOptions{Now: now.Add(time.Second), Consumer: jti, ResolvedWS: "22222222-2222-2222-2222-222222222222"}
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
	c := NewCatalog()
	if c.SDK != SDKVersion || c.Audience != DefaultAudience {
		t.Fatalf("catalog %+v", c)
	}
	if len(c.Routes) == 0 || c.MountPrefix != MountPrefix {
		t.Fatal("routes")
	}
	if EmbedPath("/workflows/{id}") != "/embed/v1/workflows/{id}" {
		t.Fatal(EmbedPath("/workflows/{id}"))
	}
	if !c.Rules.AssertionNotInURL || !c.Rules.AudienceBound {
		t.Fatal("rules")
	}
	foundRotate := false
	for _, r := range c.API {
		if r.Path == "/api/v1/embed/keys/rotate" {
			foundRotate = true
			if !strings.Contains(r.Auth, "platform.administer") || strings.Contains(r.Auth, "workspace.administer") {
				t.Fatalf("rotate auth %q", r.Auth)
			}
		}
	}
	if !foundRotate {
		t.Fatal("catalog missing rotate route")
	}
	if len(c.Hooks) < 3 {
		t.Fatal("expected E11.2 hooks")
	}
	for _, h := range c.Hooks {
		if h.Status != "ready" {
			t.Fatalf("hook %s status %s", h.ID, h.Status)
		}
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
	old := TestMaterial()
	ring := NewRing(old, NewMemoryKeys())
	foreign := NewEphemeralMaterial()
	foreign.KeyID = "attacker-kid"
	err := ring.AddOverlap(ctx, PublicJWK{
		Kty: KeyType, Crv: Curve, X: encodePublicX(foreign.Public), Kid: foreign.KeyID,
		Use: "sig", Alg: Algorithm,
	}, time.Time{})
	if err != ErrOverlapNotPrior {
		t.Fatalf("foreign key: %v", err)
	}

	active := old.PublicJWKS().Keys[0]
	if err := ring.AddOverlap(ctx, active, time.Time{}); err != nil {
		t.Fatalf("prior active: %v", err)
	}
	next := NewEphemeralMaterial()
	next.KeyID = "next-active"
	if err := ring.InstallActive(next); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(ring.Material(), minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyID != old.KeyID {
		t.Fatalf("kid %s", got.KeyID)
	}

	wrongX := active
	wrongX.X = encodePublicX(foreign.Public)
	if err := ring.AddOverlap(ctx, wrongX, time.Time{}); err != ErrOverlapNotPrior {
		t.Fatalf("kid reuse with foreign x: %v", err)
	}
	if err := ring.AddOverlap(ctx, PublicJWK{
		Kty: KeyType, Crv: Curve, X: encodePublicX(foreign.Public), Kid: old.KeyID,
		Use: "sig", Alg: Algorithm,
	}, time.Time{}); err != ErrOverlapNotPrior {
		t.Fatalf("old kid with foreign x after handoff: %v", err)
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
		Use: "sig", Alg: Algorithm, Status: KeyStatusOverlap,
	}}
	minted, _, err := Mint(old, testMintInput(now))
	if err != nil {
		t.Fatal(err)
	}
	got, err := Verify(active, minted.Assertion, VerifyOptions{
		Now: now.Add(time.Second), SkipJTI: true, ResolvedWS: "22222222-2222-2222-2222-222222222222",
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
	}); err != ErrIssuer {
		t.Fatalf("allowlist: %v", err)
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
