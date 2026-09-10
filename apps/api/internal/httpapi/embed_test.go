package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

type embedEnv struct {
	h        http.Handler
	store    identity.Store
	keys     embed.Material
	ring     *embed.Ring
	now      *time.Time
	admin    identity.User
	ops      identity.User
	logs     *bytes.Buffer
	auditor  *embed.MemoryAuditor
	sessions session.Store
}

func newEmbedEnv(t *testing.T) embedEnv {
	t.Helper()
	return newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, nil)
}

func newEmbedEnvWithIssuers(t *testing.T, embedIssuers, portalIssuers []string) embedEnv {
	t.Helper()
	return newEmbedEnvWithStore(t, embedIssuers, portalIssuers, identity.NewMemory())
}

func newEmbedEnvWithStore(t *testing.T, embedIssuers, portalIssuers []string, store identity.Store) embedEnv {
	t.Helper()
	return newEmbedEnvWithLimits(t, embedIssuers, portalIssuers, store, embed.Limits{})
}

func newEmbedEnvWithLimits(t *testing.T, embedIssuers, portalIssuers []string, store identity.Store, limits embed.Limits) embedEnv {
	t.Helper()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := &now
	keys := embed.TestMaterial()
	ring := embed.NewRing(keys, embed.NewMemoryKeys())
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	ops := identity.User{Issuer: "https://idp.example", ExternalSubject: "platform-ops-1", DisplayName: "Platform Ops"}
	auditor := embed.NewMemoryAuditor()
	sessions := session.NewMemory()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:         store,
		Scoped:        isolation.NewMemory(),
		Sessions:      sessions,
		Workflows:     wfstore.NewMemory(),
		Ops:           opsconfig.NewMemory(),
		Hooks:         webhook.NewMemory(),
		Vault:         vault.NewMemory(vault.TestKeys(), nil),
		Keys:          vault.TestKeys(),
		EmbedKeys:     keys,
		EmbedRing:     ring,
		EmbedJTI:      embed.NewMemoryJTI(),
		EmbedIssuers:  embedIssuers,
		PortalIssuers: portalIssuers,
		EmbedLimits:   limits,
		EmbedAuditor:  auditor,
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  ops.Issuer,
			Subject: ops.ExternalSubject,
		}},
		Now: func() time.Time { return *clock },
		Log: log,
	}))
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	seedWorkspace(t, store, admin, "acme", "ops", "Ops")
	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.Header.Set(headerIssuer, admin.Issuer)
	req.Header.Set(headerSubject, admin.ExternalSubject)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("current workspace: %d %s", rec.Code, rec.Body.String())
	}
	var current currentWorkspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	return embedEnv{h: h, store: store, keys: keys, ring: ring, now: clock, admin: current.Principal, ops: ops, logs: &buf, auditor: auditor, sessions: sessions}
}

func (e embedEnv) advance(d time.Duration) {
	*e.now = e.now.Add(d)
}

func (e embedEnv) mint(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	return e.mintAs(t, e.admin, body)
}

func (e embedEnv) mintAs(t *testing.T, user identity.User, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/assertions", body, user)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e embedEnv) addWorkspaceAdmin(t *testing.T, user identity.User) identity.User {
	t.Helper()
	ctx := t.Context()
	u, err := e.store.UpsertUser(ctx, user.Issuer, user.ExternalSubject, user.DisplayName)
	if err != nil {
		t.Fatal(err)
	}
	ws, _ := currentWorkspace(t, e.h, e.admin)
	if err := e.store.SetMemberRoles(ctx, ws.ID, u.ID, []string{authz.RoleAdmin}); err != nil {
		t.Fatal(err)
	}
	return u
}

func TestEmbedMintHappyPath(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view","execution.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if minted.Assertion == "" || minted.TokenID == "" || minted.SDK != embed.SDKVersion {
		t.Fatalf("minted %+v", minted)
	}
	if minted.Audience != embed.DefaultAudience || minted.Algorithm != embed.Algorithm {
		t.Fatalf("aud/alg %+v", minted)
	}
	if minted.Subject != env.admin.ExternalSubject {
		t.Fatalf("subject %q", minted.Subject)
	}
	body := rec.Body.String()
	if strings.Contains(body, "BEGIN") || strings.Contains(strings.ToLower(body), "private") {
		t.Fatal("private key material in mint response")
	}
	if strings.Contains(body, embed.EncodeSeedB64(env.keys.Private)) {
		t.Fatal("signing seed returned")
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"sdk":"embed.v1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	var exchanged embedExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.ID == "" || exchanged.CSRFToken == "" {
		t.Fatalf("session %+v", exchanged)
	}
	if strings.Contains(rec.Body.String(), minted.Assertion) {
		t.Fatal("exchange must not echo the compact assertion")
	}
	if exchanged.Workspace.WorkbenchKey != "ops" {
		t.Fatalf("workspace %+v", exchanged.Workspace)
	}
	if exchanged.Session.Embed == nil || exchanged.Session.Embed.WorkbenchKey != "ops" {
		t.Fatalf("session embed binding %+v", exchanged.Session.Embed)
	}
	if exchanged.Session.Embed.TenantID != exchanged.Tenant.ID {
		t.Fatalf("session tenant %s", exchanged.Session.Embed.TenantID)
	}
	if exchanged.Session.Embed.Mode != "embed" || exchanged.Session.Embed.SDK != embed.SDKVersion {
		t.Fatalf("exchange chrome mode/sdk %+v", exchanged.Session.Embed)
	}
	if exchanged.Session.Embed.TenantSlug != "acme" || exchanged.Session.Embed.WorkspaceName != "Ops" {
		t.Fatalf("exchange chrome display %+v", exchanged.Session.Embed)
	}
	foundSession := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" {
			foundSession = true
		}
		if strings.Contains(strings.ToLower(c.Name), "private") {
			t.Fatal("private cookie")
		}
	}
	if !foundSession {
		t.Fatal("expected ff_session")
	}
}

func TestEmbedExchangeIssuesCHIPSCookies(t *testing.T) {
	env := newEmbedEnv(t)
	mintedRec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if mintedRec.Code != http.StatusCreated {
		t.Fatalf("mint: %d %s", mintedRec.Code, mintedRec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(mintedRec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"sdk":"embed.v1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("exchange: %d %s", rec.Code, rec.Body.String())
	}
	assertRawCHIPSSetCookie(t, rec)

	var token, csrf string
	for _, c := range rec.Result().Cookies() {
		switch c.Name {
		case session.CookieName:
			token = c.Value
		case session.CSRFCookieName:
			csrf = c.Value
		}
	}
	if token == "" || csrf == "" {
		t.Fatal("missing session pair")
	}

	refresh := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/session/refresh", "", token, csrf)
	env.h.ServeHTTP(refresh, req)
	if refresh.Code != http.StatusOK {
		t.Fatalf("refresh: %d %s", refresh.Code, refresh.Body.String())
	}
	assertRawCHIPSSetCookie(t, refresh)
	token, csrf = sessionPair(t, refresh)

	logout := httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodPost, "/api/v1/session/logout", "", token, csrf)
	env.h.ServeHTTP(logout, req)
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", logout.Code, logout.Body.String())
	}
	joined := strings.ToLower(strings.Join(logout.Header().Values("Set-Cookie"), "\n"))
	if !strings.Contains(joined, "partitioned") || !strings.Contains(joined, "samesite=none") {
		t.Fatalf("logout must expire the CHIPS pair: %v", logout.Header().Values("Set-Cookie"))
	}
	if !strings.Contains(joined, "samesite=lax") {
		t.Fatalf("logout must also expire the first-party pair: %v", logout.Header().Values("Set-Cookie"))
	}
}

func TestEmbedMintMissingClaims(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{}`)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}

func TestEmbedExchangeWrongAudience(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     "other-audience",
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
	if !strings.Contains(rec.Body.String(), "audience") {
		t.Fatalf("detail should mention audience: %s", rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), token) {
		t.Fatal("assertion leaked in problem")
	}
}

func TestEmbedExchangeExpired(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	env.advance(2 * time.Minute)
	ex := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(ex, req)
	assertProblem(t, ex, http.StatusUnauthorized, CodeUnauthenticated, "")
	if !strings.Contains(ex.Body.String(), "expired") {
		t.Fatalf("detail should mention expired: %s", ex.Body.String())
	}
}

func TestEmbedJWKSNeverReturnsPrivateKeys(t *testing.T) {
	env := newEmbedEnv(t)
	rec := httptest.NewRecorder()
	env.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/embed/jwks", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	if strings.Contains(body, embed.EncodeSeedB64(env.keys.Private)) {
		t.Fatal("seed leaked")
	}
	if strings.Contains(body, `"d"`) || strings.Contains(body, "BEGIN PRIVATE") {
		t.Fatal("private jwk leaked")
	}
	var jwks embed.JWKS
	if err := json.Unmarshal(rec.Body.Bytes(), &jwks); err != nil {
		t.Fatal(err)
	}
	if !jwks.SigningReady || len(jwks.Keys) != 1 || jwks.Keys[0].X == "" {
		t.Fatalf("jwks %+v", jwks)
	}
}

func TestEmbedCatalogAndSecretFreeLogs(t *testing.T) {
	env := newEmbedEnv(t)
	rec := httptest.NewRecorder()
	env.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/embed/catalog", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"sdk":"embed.v1"`) {
		t.Fatal(rec.Body.String())
	}
	var public embed.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &public); err != nil {
		t.Fatal(err)
	}
	if embed.CatalogDisclosesMembershipIsolation(public) {
		t.Fatal("unauthenticated catalog leaked membership/isolation")
	}
	if !public.Rules.MembershipIsolationRequiresGrant || public.Rules.MembershipIsolationGranted {
		t.Fatalf("public grant flags %+v", public.Rules)
	}
	if !strings.Contains(rec.Body.String(), `"/api/v1/embed/exchange"`) || !strings.Contains(rec.Body.String(), `"/api/v1/session"`) {
		t.Fatal("minimized catalog must keep exchange/session essentials")
	}
	if !strings.Contains(rec.Body.String(), `"maxOverlapTtl":"4h0m0s"`) {
		t.Fatal("catalog must document the overlapUntil cap")
	}
	if !strings.Contains(rec.Body.String(), `"verifyBeforeWorkspaceLookup":true`) {
		t.Fatal("catalog must require verify before workspace lookup")
	}
	if !strings.Contains(rec.Body.String(), `"jtiRetainPastExpiry":true`) {
		t.Fatal("catalog must retain used jtis past assertion exp")
	}
	if !strings.Contains(rec.Body.String(), `"authzAudited":true`) {
		t.Fatal("catalog must document authz audit")
	}
	if !strings.Contains(rec.Body.String(), `"exchangeRateLimited":true`) {
		t.Fatal("catalog must document exchange rate-limit")
	}
	if !strings.Contains(rec.Body.String(), `"jtiRetention":"24h0m0s"`) {
		t.Fatal("catalog must document the 24h jti retention window")
	}
	if !strings.Contains(rec.Body.String(), `"nbfLeeway":"30s"`) {
		t.Fatal("catalog must document the default nbf leeway")
	}
	if !strings.Contains(rec.Body.String(), `"maxNbfLeeway":"1m0s"`) {
		t.Fatal("catalog must document the nbf leeway hard max")
	}
	if !strings.Contains(rec.Body.String(), `"sharedHostAllowlist":true`) {
		t.Fatal("catalog must document the shared host allowlist")
	}
	if !strings.Contains(rec.Body.String(), `"emptyHostAllowlistFailsClosed":true`) {
		t.Fatal("catalog must fail closed on an empty host allowlist")
	}
	if !strings.Contains(rec.Body.String(), `"postMessageUsesFrameAncestors":true`) {
		t.Fatal("catalog must bind postMessage to frameAncestors")
	}
	if !strings.Contains(rec.Body.String(), `"frameAncestors":[`) && !strings.Contains(rec.Body.String(), `"frameAncestors":null`) && !strings.Contains(rec.Body.String(), `"frameAncestors":[]`) {
		t.Fatal("catalog must publish frameAncestors")
	}

	mintedRec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if mintedRec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", mintedRec.Code, mintedRec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(mintedRec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	out := env.logs.String()
	if strings.Contains(out, minted.Assertion) {
		t.Fatal("assertion leaked into logs")
	}
	if strings.Contains(out, embed.EncodeSeedB64(env.keys.Private)) {
		t.Fatal("private key leaked into logs")
	}
	if !strings.Contains(out, "embed.minted") {
		t.Fatalf("expected embed audit: %s", out)
	}
}

func TestEmbedCatalogPublishesSharedHostAllowlist(t *testing.T) {
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := &now
	keys := embed.TestMaterial()
	store := identity.NewMemory()
	frames := []string{"https://portal.example", "https://host.example"}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:                store,
		Scoped:               isolation.NewMemory(),
		Sessions:             session.NewMemory(),
		Workflows:            wfstore.NewMemory(),
		Ops:                  opsconfig.NewMemory(),
		Hooks:                webhook.NewMemory(),
		Vault:                vault.NewMemory(vault.TestKeys(), nil),
		Keys:                 vault.TestKeys(),
		EmbedKeys:            keys,
		EmbedJTI:             embed.NewMemoryJTI(),
		PortalFrameAncestors: frames,
		Now:                  func() time.Time { return *clock },
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/embed/catalog", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog %d %s", rec.Code, rec.Body.String())
	}
	var cat embed.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatal(err)
	}
	if len(cat.FrameAncestors) != 2 || cat.FrameAncestors[0] != frames[0] || cat.FrameAncestors[1] != frames[1] {
		t.Fatalf("catalog frames %v want %v", cat.FrameAncestors, frames)
	}
	if !cat.Rules.SharedHostAllowlist || !cat.Rules.EmptyHostAllowlistFailsClosed || !cat.Rules.PostMessageUsesFrameAncestors || !cat.Rules.ExchangeBindsHostIssuer {
		t.Fatalf("allowlist rules %+v", cat.Rules)
	}
	if embed.CatalogDisclosesMembershipIsolation(cat) {
		t.Fatal("unauthenticated allowlist catalog leaked membership/isolation")
	}

	empty := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:     identity.NewMemory(),
		Scoped:    isolation.NewMemory(),
		Sessions:  session.NewMemory(),
		Workflows: wfstore.NewMemory(),
		Ops:       opsconfig.NewMemory(),
		Hooks:     webhook.NewMemory(),
		Vault:     vault.NewMemory(vault.TestKeys(), nil),
		Keys:      vault.TestKeys(),
		EmbedKeys: keys,
		EmbedJTI:  embed.NewMemoryJTI(),
		Now:       func() time.Time { return *clock },
	}))
	emptyRec := httptest.NewRecorder()
	empty.ServeHTTP(emptyRec, httptest.NewRequest(http.MethodGet, "/api/v1/embed/catalog", nil))
	var emptyCat embed.Catalog
	if err := json.Unmarshal(emptyRec.Body.Bytes(), &emptyCat); err != nil {
		t.Fatal(err)
	}
	if len(emptyCat.FrameAncestors) != 0 {
		t.Fatalf("empty allowlist must publish empty frameAncestors, got %v", emptyCat.FrameAncestors)
	}
}

func TestEmbedMintRejectsCapabilityEscalation(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["not.a.permission"]}`)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}

func TestEmbedExchangeReplayConflict(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	body := `{"assertion":` + mustQuoteJSON(t, minted.Assertion) + `}`
	first := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(first, req)
	if first.Code != http.StatusCreated {
		t.Fatalf("first exchange %d %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(second, req)
	assertProblem(t, second, http.StatusConflict, CodeConflict, "")
}

func TestEmbedExchangeUsedJTIRejectedAfterAssertionExp(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	tid := tenantID(t, env)
	jti := "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
	firstToken := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      jti,
		TenantID:     tid,
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	first := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, firstToken)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(first, req)
	if first.Code != http.StatusCreated {
		t.Fatalf("first exchange %d %s", first.Code, first.Body.String())
	}
	later := now.Add(2 * time.Minute)
	*env.now = later
	reused := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    later.Unix(),
		ExpiresAt:    later.Add(time.Minute).Unix(),
		TokenID:      jti,
		TenantID:     tid,
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	second := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, reused)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(second, req)
	assertProblem(t, second, http.StatusConflict, CodeConflict, "")
}

func TestEmbedExchangeNBF(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Add(time.Minute).Unix(),
		ExpiresAt:    now.Add(2 * time.Minute).Unix(),
		TokenID:      "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestEmbedExchangeNBFWithinLeeway(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Add(embed.DefaultNBFLeeway).Unix(),
		ExpiresAt:    now.Add(2 * time.Minute).Unix(),
		TokenID:      "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("nbf at default leeway bound: %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbedExchangeNBFBeyondLeeway(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Add(embed.DefaultNBFLeeway + time.Second).Unix(),
		ExpiresAt:    now.Add(2 * time.Minute).Unix(),
		TokenID:      "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestEmbedExchangeCrossTenantWorkbenchRejected(t *testing.T) {
	env := newEmbedEnv(t)
	seedWorkspace(t, env.store, env.admin, "acme", "other", "Other")

	mintedRec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	var minted embed.Minted
	if err := json.Unmarshal(mintedRec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(ex, req)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange %d %s", ex.Code, ex.Body.String())
	}
	var token, csrf string
	for _, c := range ex.Result().Cookies() {
		switch c.Name {
		case session.CookieName:
			token = c.Value
		case session.CSRFCookieName:
			csrf = c.Value
		}
	}
	if token == "" {
		t.Fatal("missing session")
	}

	wrong := httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "other")
	env.h.ServeHTTP(wrong, req)
	if wrong.Code != http.StatusForbidden && wrong.Code != http.StatusBadRequest {
		t.Fatalf("cross-workbench status %d %s", wrong.Code, wrong.Body.String())
	}

	okRec := httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(okRec, req)
	if okRec.Code != http.StatusOK {
		t.Fatalf("matching headers %d %s", okRec.Code, okRec.Body.String())
	}
}

func TestEmbedKeyRotationRequiresPlatformAdminAndPriorActiveKey(t *testing.T) {
	env := newEmbedEnv(t)
	active := env.keys.PublicJWKS().Keys[0]
	foreign := embed.NewEphemeralMaterial()
	foreign.KeyID = "attacker-kid"
	attackerJWK := embed.PublicJWK{
		Kty: embed.KeyType, Crv: embed.Curve, Kid: foreign.KeyID,
		X: encodeEmbedPub(foreign), Use: "sig", Alg: embed.Algorithm,
	}

	until := env.now.Add(2 * time.Minute).Format(time.RFC3339)
	wsAdminBody, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": attackerJWK, "overlapUntil": until})
	if err != nil {
		t.Fatal(err)
	}
	denied := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(wsAdminBody), env.admin)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusForbidden, CodeForbidden, "")

	foreignBody, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": attackerJWK, "overlapUntil": until})
	if err != nil {
		t.Fatal(err)
	}
	badKey := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(foreignBody), env.ops)
	env.h.ServeHTTP(badKey, req)
	assertProblem(t, badKey, http.StatusBadRequest, CodeInvalidRequest, "")
	if !strings.Contains(badKey.Body.String(), "previous active") {
		t.Fatalf("detail should mention previous active key: %s", badKey.Body.String())
	}

	wrongX := active
	wrongX.X = encodeEmbedPub(foreign)
	wrongBody, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": wrongX, "overlapUntil": until})
	if err != nil {
		t.Fatal(err)
	}
	wrong := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(wrongBody), env.ops)
	env.h.ServeHTTP(wrong, req)
	assertProblem(t, wrong, http.StatusBadRequest, CodeInvalidRequest, "")

	handoff, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": active, "overlapUntil": until})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(handoff), env.ops)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("platform-admin rotate %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"d"`) || strings.Contains(rec.Body.String(), embed.EncodeSeedB64(env.keys.Private)) {
		t.Fatal("private key leaked from rotate")
	}
	if !strings.Contains(env.logs.String(), "embed.key.overlap_registered") {
		t.Fatalf("expected rotation audit: %s", env.logs.String())
	}

	next := embed.NewEphemeralMaterial()
	next.KeyID = "next-active"
	if err := env.ring.InstallActive(next); err != nil {
		t.Fatal(err)
	}
	jwks := httptest.NewRecorder()
	env.h.ServeHTTP(jwks, httptest.NewRequest(http.MethodGet, "/api/v1/embed/jwks", nil))
	if !strings.Contains(jwks.Body.String(), env.keys.KeyID) || !strings.Contains(jwks.Body.String(), next.KeyID) {
		t.Fatalf("jwks should publish active + overlap: %s", jwks.Body.String())
	}

	now := *env.now
	token, _, err := embed.Mint(env.keys, embed.MintInput{
		Issuer:       "https://idp.example",
		Subject:      "admin-1",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		TTL:          embed.DefaultTTL,
		Audience:     embed.DefaultAudience,
		Now:          now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ex := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(ex, req)
	if ex.Code != http.StatusCreated {
		t.Fatalf("overlap exchange %d %s", ex.Code, ex.Body.String())
	}

	forged, _, err := embed.Mint(foreign, embed.MintInput{
		Issuer:       "https://idp.example",
		Subject:      "admin-1",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		TTL:          embed.DefaultTTL,
		Audience:     embed.DefaultAudience,
		Now:          now,
	})
	if err != nil {
		t.Fatal(err)
	}
	rej := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, forged.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rej, req)
	assertProblem(t, rej, http.StatusUnauthorized, CodeUnauthenticated, "")

	retire, err := json.Marshal(map[string]any{"action": "retire", "kid": env.keys.KeyID})
	if err != nil {
		t.Fatal(err)
	}
	adminRetire := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(retire), env.admin)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(adminRetire, req)
	assertProblem(t, adminRetire, http.StatusForbidden, CodeForbidden, "")

	okRetire := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(retire), env.ops)
	env.h.ServeHTTP(okRetire, req)
	if okRetire.Code != http.StatusOK {
		t.Fatalf("retire %d %s", okRetire.Code, okRetire.Body.String())
	}
	if strings.Contains(okRetire.Body.String(), env.keys.KeyID) {
		t.Fatal("retired overlap kid should leave JWKS")
	}
}

func TestEmbedExchangeExpiredOverlapRejected(t *testing.T) {
	env := newEmbedEnv(t)
	until := env.now.Add(90 * time.Second)
	active := env.keys.PublicJWKS().Keys[0]
	body, err := json.Marshal(map[string]any{
		"action":       "register-overlap",
		"publicJwk":    active,
		"overlapUntil": until.Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(body), env.ops)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("register-overlap %d %s", rec.Code, rec.Body.String())
	}
	next := embed.NewEphemeralMaterial()
	next.KeyID = "next-after-rotate"
	if err := env.ring.InstallActive(next); err != nil {
		t.Fatal(err)
	}

	minted, _, err := embed.Mint(env.keys, embed.MintInput{
		Issuer:       "https://idp.example",
		Subject:      "admin-1",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		TTL:          embed.DefaultTTL,
		Audience:     embed.DefaultAudience,
		Now:          *env.now,
	})
	if err != nil {
		t.Fatal(err)
	}
	ok := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(ok, req)
	if ok.Code != http.StatusCreated {
		t.Fatalf("overlap still valid %d %s", ok.Code, ok.Body.String())
	}

	env.advance(91 * time.Second)
	later, _, err := embed.Mint(env.keys, embed.MintInput{
		Issuer:       "https://idp.example",
		Subject:      "admin-1",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		TTL:          embed.DefaultTTL,
		Audience:     embed.DefaultAudience,
		Now:          *env.now,
	})
	if err != nil {
		t.Fatal(err)
	}
	rej := httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, later.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rej, req)
	assertProblem(t, rej, http.StatusUnauthorized, CodeUnauthenticated, "")
}

func TestEmbedRotateRequiresShortOverlapUntil(t *testing.T) {
	env := newEmbedEnv(t)
	active := env.keys.PublicJWKS().Keys[0]

	missing, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": active})
	if err != nil {
		t.Fatal(err)
	}
	miss := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(missing), env.ops)
	env.h.ServeHTTP(miss, req)
	assertProblem(t, miss, http.StatusBadRequest, CodeInvalidRequest, "")
	if !strings.Contains(miss.Body.String(), "overlapUntil") {
		t.Fatalf("missing overlapUntil: %s", miss.Body.String())
	}

	tooLong, err := json.Marshal(map[string]any{
		"action":       "register-overlap",
		"publicJwk":    active,
		"overlapUntil": env.now.Add(48 * time.Hour).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	long := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(tooLong), env.ops)
	env.h.ServeHTTP(long, req)
	assertProblem(t, long, http.StatusBadRequest, CodeInvalidRequest, "")
	if !strings.Contains(long.Body.String(), "4h") {
		t.Fatalf("too-long overlapUntil: %s", long.Body.String())
	}

	okBody, err := json.Marshal(map[string]any{
		"action":       "register-overlap",
		"publicJwk":    active,
		"overlapUntil": env.now.Add(30 * time.Minute).Format(time.RFC3339),
	})
	if err != nil {
		t.Fatal(err)
	}
	ok := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(okBody), env.ops)
	env.h.ServeHTTP(ok, req)
	if ok.Code != http.StatusOK {
		t.Fatalf("valid short overlapUntil %d %s", ok.Code, ok.Body.String())
	}
	if !strings.Contains(ok.Body.String(), env.keys.KeyID) {
		t.Fatalf("JWKS should list overlap kid: %s", ok.Body.String())
	}
}

func TestEmbedMintEmptyAllowlistDenied(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, nil, nil)
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if !strings.Contains(rec.Body.String(), "allowlist") {
		t.Fatalf("detail should mention allowlist: %s", rec.Body.String())
	}
}

func TestEmbedExchangeEmptyAllowlistDenied(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, nil, nil)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintUnknownIssuerDenied(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"],"issuer":"https://hostile.example"}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedExchangeUnknownIssuerDenied(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://hostile.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintEmptyAllowlistDeniedWhenPortalSet(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, nil, []string{"https://portal.cp-ops.example"})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedExchangeAcceptsPortalIssuerWhenEmbedEmpty(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, nil, []string{"https://portal.cp-ops.example"})
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://portal.cp-ops.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("portal issuer exchange %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbedExchangeWrongHostIssuerDenied(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, []string{"https://portal.cp-ops.example"})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}

	wrong := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"sdk":"embed.v1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerHostIssuer, "https://portal.cp-ops.example")
	req.Header.Set(headerHostContext, embed.HostContextPortal)
	env.h.ServeHTTP(wrong, req)
	assertProblem(t, wrong, http.StatusForbidden, CodeForbidden, "")
	if !strings.Contains(wrong.Body.String(), "minting host") {
		t.Fatalf("detail should mention minting host: %s", wrong.Body.String())
	}
}

func TestEmbedExchangeHostIssuerBindingSucceeds(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, []string{"https://portal.cp-ops.example"})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}

	ok := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"sdk":"embed.v1","hostIssuer":"https://idp.example","hostContext":"embed"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerHostIssuer, "https://idp.example")
	req.Header.Set(headerHostContext, embed.HostContextEmbed)
	env.h.ServeHTTP(ok, req)
	if ok.Code != http.StatusCreated {
		t.Fatalf("bound exchange %d %s", ok.Code, ok.Body.String())
	}
}

func TestEmbedExchangeAmbiguousHostRequiresBinding(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, []string{"https://portal.cp-ops.example"})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	denied := postEmbedExchange(t, env, minted.Assertion)
	assertProblem(t, denied, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedExchangePortalContextRejectsEmbedIssuer(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, []string{"https://portal.cp-ops.example"})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}

	denied := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerHostContext, embed.HostContextPortal)
	env.h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedExchangePortalContextAcceptsPortalIssuer(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, []string{"https://portal.cp-ops.example"})
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://portal.cp-ops.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
		Host:         "https://portal.cp-ops.example",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerHostIssuer, "https://portal.cp-ops.example")
	req.Header.Set(headerHostContext, embed.HostContextPortal)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("portal-bound exchange %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbedExchangeHostClaimMismatchDenied(t *testing.T) {
	env := newEmbedEnv(t)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
		Host:         "https://portal.cp-ops.example",
	})
	rec := postEmbedExchange(t, env, token)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedExchangeHeaderBodyHostMismatchDenied(t *testing.T) {
	env := newEmbedEnvWithIssuers(t, []string{"https://idp.example"}, []string{"https://portal.cp-ops.example"})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	denied := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"hostIssuer":"https://idp.example"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(headerHostIssuer, "https://portal.cp-ops.example")
	env.h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintAllowlistedIssuerSucceeds(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"],"issuer":"https://idp.example"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("allowlisted mint %d %s", rec.Code, rec.Body.String())
	}
}

func newHTTPIssuerEmbedEnv(t *testing.T, issuer string) embedEnv {
	t.Helper()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := &now
	keys := embed.TestMaterial()
	store := identity.NewMemory()
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	admin := identity.User{Issuer: issuer, ExternalSubject: "admin-1", DisplayName: "Admin"}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:        store,
		Scoped:       isolation.NewMemory(),
		Sessions:     session.NewMemory(),
		Workflows:    wfstore.NewMemory(),
		Ops:          opsconfig.NewMemory(),
		Hooks:        webhook.NewMemory(),
		Vault:        vault.NewMemory(vault.TestKeys(), nil),
		Keys:         vault.TestKeys(),
		EmbedKeys:    keys,
		EmbedJTI:     embed.NewMemoryJTI(),
		EmbedIssuers: []string{issuer},
		Now:          func() time.Time { return *clock },
		Log:          log,
	}))
	seedWorkspace(t, store, admin, "acme", "ops", "Ops")
	return embedEnv{h: h, store: store, keys: keys, now: clock, admin: admin, logs: &buf, sessions: session.NewMemory()}
}

func TestEmbedMintHTTPIssuerDeniedInProduction(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("REQUIRE_TLS", "")
	env := newHTTPIssuerEmbedEnv(t, "http://idp.example")
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedExchangeHTTPIssuerDeniedInProduction(t *testing.T) {
	t.Setenv("APP_ENV", "production")
	t.Setenv("REQUIRE_TLS", "")
	env := newHTTPIssuerEmbedEnv(t, "http://idp.example")
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "http://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
		Host:         "http://idp.example",
	})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, token)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintHTTPIssuerAllowedInDevelopment(t *testing.T) {
	t.Setenv("APP_ENV", "development")
	t.Setenv("REQUIRE_TLS", "")
	env := newHTTPIssuerEmbedEnv(t, "http://idp.example")
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("non-prod http mint %d %s", rec.Code, rec.Body.String())
	}
}

func TestEmbedMintRejectsForeignSubject(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"],"subject":"other-user"}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if !strings.Contains(env.logs.String(), "impersonation") {
		t.Fatalf("expected impersonation deny audit: %s", env.logs.String())
	}
}

func TestEmbedMintRejectsSpoofedIssuer(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"],"issuer":"https://hostile.example"}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintImpersonationWithoutPermission(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"],"subject":"impersonated-user","issuer":"https://idp.example"}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
}

func TestEmbedMintImpersonationWithPermissionIsAudited(t *testing.T) {
	env := newEmbedEnv(t)
	ops := env.addWorkspaceAdmin(t, env.ops)
	rec := env.mintAs(t, ops, `{"capabilities":["workflow.view"],"subject":"impersonated-user"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("impersonate mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if minted.Subject != "impersonated-user" {
		t.Fatalf("subject %q", minted.Subject)
	}
	if minted.Issuer != env.ops.Issuer {
		t.Fatalf("issuer must stay the caller, got %q", minted.Issuer)
	}
	out := env.logs.String()
	if !strings.Contains(out, "embed.minted") || !strings.Contains(out, "impersonated") {
		t.Fatalf("expected impersonation audit: %s", out)
	}
	if strings.Contains(out, minted.Assertion) {
		t.Fatal("assertion leaked into logs")
	}
}

func TestEmbedMintImpersonationStillEnforcesCapsSubset(t *testing.T) {
	env := newEmbedEnv(t)
	ops := env.addWorkspaceAdmin(t, env.ops)
	rec := env.mintAs(t, ops, `{"capabilities":["workflow.view","not.a.permission"],"subject":"impersonated-user"}`)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}

func TestEmbedExchangeForgedAssertionNeverLooksUpWorkspace(t *testing.T) {
	spy := newIdentityLookupSpy(identity.NewMemory())
	env := newEmbedEnvWithStore(t, []string{"https://idp.example"}, nil, spy)
	existingTenant := tenantID(t, env)
	spy.Reset()
	foreign := embed.NewEphemeralMaterial()
	now := *env.now
	existingWS := signClaims(t, foreign, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		TenantID:     existingTenant,
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	missingWS := signClaims(t, foreign, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		TenantID:     "99999999-9999-4999-8999-999999999999",
		WorkbenchKey: "missing",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})

	existRec := postEmbedExchange(t, env, existingWS)
	missRec := postEmbedExchange(t, env, missingWS)
	existProb := assertProblem(t, existRec, http.StatusUnauthorized, CodeUnauthenticated, "")
	missProb := assertProblem(t, missRec, http.StatusUnauthorized, CodeUnauthenticated, "")
	if existProb.Title != missProb.Title || existProb.Detail != missProb.Detail || existProb.Code != missProb.Code {
		t.Fatalf("oracle: existing workspace %+v vs missing %+v", existProb, missProb)
	}
	if lookups := spy.workspaceLookups(); len(lookups) != 0 {
		t.Fatalf("forged assertion must not look up workspace: %v", lookups)
	}
}

func TestEmbedExchangeInvalidClaimsNeverLookUpWorkspace(t *testing.T) {
	spy := newIdentityLookupSpy(identity.NewMemory())
	env := newEmbedEnvWithStore(t, []string{"https://idp.example"}, nil, spy)
	now := *env.now
	tid := tenantID(t, env)
	spy.Reset()

	wrongAud := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     "other-audience",
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
		TenantID:     tid,
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	unknownIss := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://hostile.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
		TenantID:     tid,
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})

	audRec := postEmbedExchange(t, env, wrongAud)
	issRec := postEmbedExchange(t, env, unknownIss)
	assertProblem(t, audRec, http.StatusUnauthorized, CodeUnauthenticated, "")
	assertProblem(t, issRec, http.StatusForbidden, CodeForbidden, "")
	if lookups := spy.workspaceLookups(); len(lookups) != 0 {
		t.Fatalf("invalid assertion must not look up workspace: %v", lookups)
	}
}

func TestEmbedExchangeValidAssertionBindsTenancyAfterVerify(t *testing.T) {
	spy := newIdentityLookupSpy(identity.NewMemory())
	env := newEmbedEnvWithStore(t, []string{"https://idp.example"}, nil, spy)
	mintedRec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if mintedRec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", mintedRec.Code, mintedRec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(mintedRec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	spy.Reset()

	rec := postEmbedExchange(t, env, minted.Assertion)
	if rec.Code != http.StatusCreated {
		t.Fatalf("exchange %d %s", rec.Code, rec.Body.String())
	}
	var exchanged embedExchangeResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.Embed == nil || exchanged.Session.Embed.WorkbenchKey != "ops" {
		t.Fatalf("session embed binding %+v", exchanged.Session.Embed)
	}
	if exchanged.Session.Embed.TenantID != exchanged.Tenant.ID {
		t.Fatalf("session tenant %s", exchanged.Session.Embed.TenantID)
	}
	lookups := spy.workspaceLookups()
	if len(lookups) != 1 || lookups[0] != "ResolveWorkspace" {
		t.Fatalf("valid exchange should resolve workspace once after verify: %v", lookups)
	}
}

func TestEmbedExchangeUnknownWorkspaceAfterVerify(t *testing.T) {
	spy := newIdentityLookupSpy(identity.NewMemory())
	env := newEmbedEnvWithStore(t, []string{"https://idp.example"}, nil, spy)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
		TenantID:     "99999999-9999-4999-8999-999999999999",
		WorkbenchKey: "missing",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	spy.Reset()

	rec := postEmbedExchange(t, env, token)
	assertProblem(t, rec, http.StatusNotFound, CodeNotFound, "")
	lookups := spy.workspaceLookups()
	if len(lookups) != 1 || lookups[0] != "ResolveWorkspace" {
		t.Fatalf("verified assertion may resolve once: %v", lookups)
	}

	replay := postEmbedExchange(t, env, token)
	assertProblem(t, replay, http.StatusConflict, CodeConflict, "")
	if extra := spy.workspaceLookups(); len(extra) != 1 {
		t.Fatalf("replay must not look up workspace again: %v", extra)
	}
}

type identityLookupSpy struct {
	identity.Store
	mu  sync.Mutex
	ops []string
}

func newIdentityLookupSpy(inner identity.Store) *identityLookupSpy {
	return &identityLookupSpy{Store: inner}
}

func (s *identityLookupSpy) Reset() {
	s.mu.Lock()
	s.ops = nil
	s.mu.Unlock()
}

func (s *identityLookupSpy) note(op string) {
	s.mu.Lock()
	s.ops = append(s.ops, op)
	s.mu.Unlock()
}

func (s *identityLookupSpy) workspaceLookups() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.ops...)
}

func (s *identityLookupSpy) ResolveWorkspace(ctx context.Context, tenantID, tenantSlug, workbenchKey string) (identity.Workspace, identity.Tenant, error) {
	s.note("ResolveWorkspace")
	return s.Store.ResolveWorkspace(ctx, tenantID, tenantSlug, workbenchKey)
}

func (s *identityLookupSpy) GetWorkspace(ctx context.Context, id string) (identity.Workspace, error) {
	s.note("GetWorkspace")
	return s.Store.GetWorkspace(ctx, id)
}

func (s *identityLookupSpy) GetTenant(ctx context.Context, id string) (identity.Tenant, error) {
	s.note("GetTenant")
	return s.Store.GetTenant(ctx, id)
}

func (s *identityLookupSpy) GetTenantBySlug(ctx context.Context, slug string) (identity.Tenant, error) {
	s.note("GetTenantBySlug")
	return s.Store.GetTenantBySlug(ctx, slug)
}

func (s *identityLookupSpy) ListMembers(ctx context.Context, workspaceID string) ([]identity.Member, error) {
	s.note("ListMembers")
	return s.Store.ListMembers(ctx, workspaceID)
}

func (s *identityLookupSpy) EffectiveAccess(ctx context.Context, workspaceID, userID string) (roles, perms []string, err error) {
	s.note("EffectiveAccess")
	return s.Store.EffectiveAccess(ctx, workspaceID, userID)
}

func (s *identityLookupSpy) ListWorkspacesForUser(ctx context.Context, userID string) ([]identity.Membership, error) {
	s.note("ListWorkspacesForUser")
	return s.Store.ListWorkspacesForUser(ctx, userID)
}

func postEmbedExchange(t *testing.T, env embedEnv, assertion string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rec, req)
	return rec
}

func encodeEmbedPub(m embed.Material) string {
	return m.PublicJWKS().Keys[0].X
}

func tenantID(t *testing.T, env embedEnv) string {
	t.Helper()
	ws, tenant := currentWorkspace(t, env.h, env.admin)
	_ = ws
	return tenant.ID
}

func mustQuoteJSON(t *testing.T, v string) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func signClaims(t *testing.T, m embed.Material, c embed.Claims) string {
	t.Helper()
	token, err := embed.Sign(m, c)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func assertNoSecretsInAudit(t *testing.T, env embedEnv, assertion string) {
	t.Helper()
	out := env.logs.String()
	if assertion != "" && strings.Contains(out, assertion) {
		t.Fatal("assertion leaked into audit logs")
	}
	if strings.Contains(out, embed.EncodeSeedB64(env.keys.Private)) {
		t.Fatal("signing seed leaked into audit logs")
	}
	for _, ev := range env.auditor.Events() {
		blob, err := json.Marshal(ev)
		if err != nil {
			t.Fatal(err)
		}
		raw := string(blob)
		if assertion != "" && strings.Contains(raw, assertion) {
			t.Fatalf("assertion leaked into audit event %+v", ev)
		}
		if strings.Contains(raw, embed.EncodeSeedB64(env.keys.Private)) {
			t.Fatalf("signing seed leaked into audit event %+v", ev)
		}
		for _, leak := range []string{"private_key", "ff_session", "BEGIN PRIVATE"} {
			if strings.Contains(raw, leak) {
				t.Fatalf("secret-shaped %q in audit event %+v", leak, ev)
			}
		}
	}
}

func TestEmbedAuthzAuditAllowAndDenyPaths(t *testing.T) {
	env := newEmbedEnv(t)

	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint allow %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if !env.auditor.Contains(embed.EventMinted, session.OutcomeAllowed, embed.ReasonIssued) {
		t.Fatalf("missing mint allow audit: %+v", env.auditor.Events())
	}

	ex := postEmbedExchange(t, env, minted.Assertion)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange allow %d %s", ex.Code, ex.Body.String())
	}
	if !env.auditor.Contains(embed.EventExchanged, session.OutcomeAllowed, embed.ReasonIssued) {
		t.Fatalf("missing exchange allow audit: %+v", env.auditor.Events())
	}

	capDeny := env.mint(t, `{"capabilities":["not.a.permission"]}`)
	assertProblem(t, capDeny, http.StatusBadRequest, CodeInvalidRequest, "")
	if !env.auditor.Contains(embed.EventRejected, session.OutcomeDenied, embed.ReasonCapability) {
		t.Fatalf("missing capability deny audit: %+v", env.auditor.Events())
	}

	imp := env.mint(t, `{"capabilities":["workflow.view"],"subject":"other-user"}`)
	assertProblem(t, imp, http.StatusForbidden, CodeForbidden, "")
	if !env.auditor.Contains(embed.EventRejected, session.OutcomeDenied, embed.ReasonImpersonation) {
		t.Fatalf("missing impersonation deny audit: %+v", env.auditor.Events())
	}

	tenancy := env.mint(t, `{"capabilities":["workflow.view"],"tenantId":"99999999-9999-4999-8999-999999999999"}`)
	if tenancy.Code == http.StatusCreated {
		t.Fatal("foreign tenant bind must fail")
	}
	if !env.auditor.Contains(embed.EventRejected, session.OutcomeDenied, embed.ReasonTenancy) {
		t.Fatalf("missing tenancy deny audit: %+v", env.auditor.Events())
	}

	now := *env.now
	forged := signClaims(t, embed.NewEphemeralMaterial(), embed.Claims{
		Issuer:       "https://idp.example",
		Audience:     embed.DefaultAudience,
		Subject:      "admin-1",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
		TenantID:     tenantID(t, env),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	bad := postEmbedExchange(t, env, forged)
	assertProblem(t, bad, http.StatusUnauthorized, CodeUnauthenticated, "")
	if !env.auditor.Contains(embed.EventRejected, session.OutcomeDenied, embed.ReasonSignature) {
		t.Fatalf("missing exchange signature deny audit: %+v", env.auditor.Events())
	}

	rotateDeny := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", `{"action":"retire","kid":"x"}`, env.admin)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(rotateDeny, req)
	assertProblem(t, rotateDeny, http.StatusForbidden, CodeForbidden, "")
	if !env.auditor.Contains(embed.EventRotateDenied, session.OutcomeDenied, embed.ReasonPrivilege) {
		t.Fatalf("missing rotate deny audit: %+v", env.auditor.Events())
	}

	ops := env.addWorkspaceAdmin(t, env.ops)
	until := env.now.Add(30 * time.Minute).Format(time.RFC3339)
	body, err := json.Marshal(map[string]any{
		"action":       "register-overlap",
		"publicJwk":    env.keys.PublicJWKS().Keys[0],
		"overlapUntil": until,
	})
	if err != nil {
		t.Fatal(err)
	}
	rotateOK := httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(body), ops)
	env.h.ServeHTTP(rotateOK, req)
	if rotateOK.Code != http.StatusOK {
		t.Fatalf("rotate allow %d %s", rotateOK.Code, rotateOK.Body.String())
	}
	if !env.auditor.Contains(embed.EventOverlapRegister, session.OutcomeAllowed, embed.ReasonOverlapReg) {
		t.Fatalf("missing rotate allow audit: %+v", env.auditor.Events())
	}

	assertNoSecretsInAudit(t, env, minted.Assertion)
}

func TestEmbedExchangeRateLimitedOnBurst(t *testing.T) {
	env := newEmbedEnvWithLimits(t, []string{"https://idp.example"}, nil, identity.NewMemory(), embed.Limits{
		Window:            time.Minute,
		ExchangeIP:        2,
		ExchangePrincipal: 100,
		MintPrincipal:     -1,
	})
	now := *env.now
	tid := tenantID(t, env)
	forged := func(n byte) string {
		return signClaims(t, embed.NewEphemeralMaterial(), embed.Claims{
			Issuer:       "https://idp.example",
			Audience:     embed.DefaultAudience,
			Subject:      "burst-user",
			NotBefore:    now.Unix(),
			ExpiresAt:    now.Add(time.Minute).Unix(),
			TokenID:      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbb0" + string(rune('0'+n)),
			TenantID:     tid,
			WorkbenchKey: "ops",
			Capabilities: []string{"workflow.view"},
			SDK:          embed.SDKVersion,
		})
	}
	first := postEmbedExchange(t, env, forged(1))
	second := postEmbedExchange(t, env, forged(2))
	assertProblem(t, first, http.StatusUnauthorized, CodeUnauthenticated, "")
	assertProblem(t, second, http.StatusUnauthorized, CodeUnauthenticated, "")
	burst := postEmbedExchange(t, env, forged(3))
	prob := assertProblem(t, burst, http.StatusTooManyRequests, CodeRateLimited, "")
	if burst.Header().Get("Retry-After") == "" {
		t.Fatal("expected Retry-After")
	}
	if !strings.Contains(prob.Detail, "rate limit") {
		t.Fatalf("detail %q", prob.Detail)
	}
	if !env.auditor.Contains(embed.EventRejected, session.OutcomeDenied, embed.ReasonRateLimited) {
		t.Fatalf("missing rate-limit audit: %+v", env.auditor.Events())
	}
	assertNoSecretsInAudit(t, env, first.Body.String())
}

func TestEmbedExchangeSucceedsUnderRateLimit(t *testing.T) {
	env := newEmbedEnvWithLimits(t, []string{"https://idp.example"}, nil, identity.NewMemory(), embed.Limits{
		Window:            time.Minute,
		ExchangeIP:        5,
		ExchangePrincipal: 5,
		MintPrincipal:     -1,
	})
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := postEmbedExchange(t, env, minted.Assertion)
	if ex.Code != http.StatusCreated {
		t.Fatalf("valid exchange under limit %d %s", ex.Code, ex.Body.String())
	}
	if env.auditor.Contains(embed.EventRejected, session.OutcomeDenied, embed.ReasonRateLimited) {
		t.Fatal("must not rate-limit a single valid exchange")
	}
	if !env.auditor.Contains(embed.EventExchanged, session.OutcomeAllowed, embed.ReasonIssued) {
		t.Fatalf("expected exchange allow: %+v", env.auditor.Events())
	}
	assertNoSecretsInAudit(t, env, minted.Assertion)
}

func TestGetSessionReturnsEmbedChromeFields(t *testing.T) {
	env := newEmbedEnv(t)
	mintedRec := env.mint(t, `{"capabilities":["workflow.view","execution.view"]}`)
	if mintedRec.Code != http.StatusCreated {
		t.Fatalf("mint: %d %s", mintedRec.Code, mintedRec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(mintedRec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}

	ex := postEmbedExchange(t, env, minted.Assertion)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange: %d %s", ex.Code, ex.Body.String())
	}
	token, csrf := sessionPair(t, ex)

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf)
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	chrome := payload.Session.Embed
	if chrome == nil {
		t.Fatal("embed-bound GET /session must include session.embed")
	}
	if chrome.Mode != "embed" || chrome.SDK != embed.SDKVersion {
		t.Fatalf("embed mode/sdk %+v", chrome)
	}
	if chrome.TenantID == "" || chrome.TenantSlug != "acme" || chrome.TenantName == "" {
		t.Fatalf("tenant chrome %+v", chrome)
	}
	if chrome.WorkbenchKey != "ops" || chrome.WorkspaceID == "" || chrome.WorkspaceName != "Ops" {
		t.Fatalf("workspace chrome %+v", chrome)
	}
	if len(chrome.Capabilities) != 2 || chrome.Capabilities[0] != "workflow.view" || chrome.Capabilities[1] != "execution.view" {
		t.Fatalf("capped capabilities %+v", chrome.Capabilities)
	}
	if payload.Principal.DisplayName == "" {
		t.Fatal("principal.display_name is the chrome-safe subject label")
	}

	body := rec.Body.String()
	if strings.Contains(body, minted.Assertion) {
		t.Fatal("GET /session leaked the compact assertion")
	}
	lower := strings.ToLower(body)
	for _, secret := range []string{`"assertion"`, `"jti"`, `"tokenid"`, `"private_key"`, `"privatekey"`, `"embed_signing_key"`, `"d":`} {
		if strings.Contains(lower, secret) {
			t.Fatalf("GET /session leaked secret field %s: %s", secret, body)
		}
	}
}

func TestEmbedCatalogHidesMembershipIsolationUnlessGranted(t *testing.T) {
	env := newEmbedEnv(t)

	public := getEmbedCatalog(t, env, "", "")
	if embed.CatalogDisclosesMembershipIsolation(public.cat) {
		t.Fatal("unauthenticated catalog leaked membership/isolation")
	}
	if public.cat.Rules.MembershipIsolationGranted || !public.cat.Rules.MembershipIsolationRequiresGrant {
		t.Fatalf("public flags %+v", public.cat.Rules)
	}
	if public.cat.Rules.ChromeFromSession == false || public.cat.Rules.SharedHostAllowlist == false {
		t.Fatal("must not regress ADV-021 / ADV-011 on the public catalog")
	}
	assertCatalogSecretFree(t, public.body, "")

	viewer := exchangeCatalog(t, env, `{"capabilities":["workflow.view"]}`)
	if embed.CatalogDisclosesMembershipIsolation(viewer.cat) {
		t.Fatal("capability-limited embed catalog leaked membership/isolation")
	}
	foundWorkflow := false
	for _, route := range viewer.cat.Routes {
		if route.ID == "workflow" {
			foundWorkflow = true
		}
	}
	if !foundWorkflow {
		t.Fatal("embed session with caps must keep product routes")
	}
	assertCatalogSecretFree(t, viewer.body, viewer.assertion)

	ws, tenant := currentWorkspace(t, env.h, env.admin)
	issued, err := env.sessions.Create(t.Context(), env.admin.ID, *env.now, session.DefaultIdleTimeout, session.DefaultAbsoluteTimeout, session.CreateOpts{
		Binding: session.Binding{
			TenantID:     tenant.ID,
			WorkbenchKey: ws.WorkbenchKey,
			WorkspaceID:  ws.ID,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	empty := getEmbedCatalog(t, env, issued.Token, issued.CSRF)
	if embed.CatalogDisclosesMembershipIsolation(empty.cat) {
		t.Fatal("capability-less embed catalog leaked membership/isolation")
	}
	if len(empty.cat.Routes) != 1 || empty.cat.Routes[0].ID != "home" {
		t.Fatalf("capability-less embed catalog must be essentials-only, got %+v", empty.cat.Routes)
	}

	granted := exchangeCatalog(t, env, `{"capabilities":["workspace.administer"]}`)
	if !embed.CatalogDisclosesMembershipIsolation(granted.cat) || !granted.cat.Rules.MembershipIsolationGranted {
		t.Fatal("workspace.administer must disclose membership/isolation")
	}
	foundMembership, foundIsolation := false, false
	for _, route := range granted.cat.Routes {
		if route.ID == embed.RouteIDMembership {
			foundMembership = true
		}
		if route.ID == embed.RouteIDIsolation {
			foundIsolation = true
		}
	}
	if !foundMembership || !foundIsolation {
		t.Fatalf("granted routes %+v", granted.cat.Routes)
	}
	assertCatalogSecretFree(t, granted.body, granted.assertion)

	grantToken, grantCSRF := sessionPair(t, granted.ex)
	portalRec := httptest.NewRecorder()
	env.h.ServeHTTP(portalRec, sessionAPIRequest(http.MethodGet, "/api/v1/portal/adapter", "", grantToken, grantCSRF))
	if portalRec.Code != http.StatusOK {
		t.Fatalf("portal catalog %d %s", portalRec.Code, portalRec.Body.String())
	}
	if !strings.Contains(portalRec.Body.String(), `"membershipIsolationGranted":true`) {
		t.Fatal("granted session must disclose membership/isolation on portal adapter")
	}
	if !strings.Contains(portalRec.Body.String(), `"/membership"`) {
		t.Fatal("granted portal catalog missing membership route")
	}

	created, _ := createSession(t, env.h, env.admin.Issuer, env.admin.ExternalSubject, "Admin", false)
	token, csrf := sessionPair(t, created)
	standalone := getEmbedCatalog(t, env, token, csrf)
	if !standalone.cat.Rules.MembershipIsolationGranted {
		t.Fatal("standalone workspace admin session must grant membership/isolation")
	}
	if embed.CatalogDisclosesMembershipIsolation(standalone.cat) == false {
		t.Fatal("standalone granted catalog missing membership/isolation")
	}

	createdOps, _ := createSession(t, env.h, env.ops.Issuer, env.ops.ExternalSubject, "Ops", false)
	opsToken, opsCSRF := sessionPair(t, createdOps)
	opsCat := getEmbedCatalog(t, env, opsToken, opsCSRF)
	if !opsCat.cat.Rules.MembershipIsolationGranted {
		t.Fatal("standalone platform-admin session must grant membership/isolation")
	}

	viewerUser := identity.User{Issuer: "https://idp.example", ExternalSubject: "viewer-catalog", DisplayName: "Viewer"}
	u, err := env.store.UpsertUser(t.Context(), viewerUser.Issuer, viewerUser.ExternalSubject, viewerUser.DisplayName)
	if err != nil {
		t.Fatal(err)
	}
	if err := env.store.SetMemberRoles(t.Context(), ws.ID, u.ID, []string{authz.RoleViewer}); err != nil {
		t.Fatal(err)
	}
	createdViewer, _ := createSession(t, env.h, viewerUser.Issuer, viewerUser.ExternalSubject, "Viewer", false)
	vToken, vCSRF := sessionPair(t, createdViewer)
	standaloneViewer := getEmbedCatalog(t, env, vToken, vCSRF)
	if standaloneViewer.cat.Rules.MembershipIsolationGranted || embed.CatalogDisclosesMembershipIsolation(standaloneViewer.cat) {
		t.Fatal("standalone viewer must not see membership/isolation")
	}
	foundWorkflow = false
	for _, route := range standaloneViewer.cat.Routes {
		if route.ID == "workflow" {
			foundWorkflow = true
		}
	}
	if !foundWorkflow {
		t.Fatal("standalone authenticated catalog must keep product routes")
	}

	matrix := httptest.NewRecorder()
	env.h.ServeHTTP(matrix, identifiedRequest(http.MethodGet, "/api/v1/permission-matrix", nil))
	if matrix.Code != http.StatusOK {
		t.Fatalf("standalone permission-matrix %d", matrix.Code)
	}
	if !strings.Contains(matrix.Body.String(), authz.PermWorkspaceAdminister) {
		t.Fatal("do not shrink the authz-gated standalone permission matrix")
	}
}

type catalogGET struct {
	cat       embed.Catalog
	body      string
	assertion string
	ex        *httptest.ResponseRecorder
}

func getEmbedCatalog(t *testing.T, env embedEnv, token, csrf string) catalogGET {
	t.Helper()
	rec := httptest.NewRecorder()
	var req *http.Request
	if token == "" {
		req = httptest.NewRequest(http.MethodGet, "/api/v1/embed/catalog", nil)
	} else {
		req = sessionAPIRequest(http.MethodGet, "/api/v1/embed/catalog", "", token, csrf)
	}
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("catalog %d %s", rec.Code, rec.Body.String())
	}
	var cat embed.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatal(err)
	}
	return catalogGET{cat: cat, body: rec.Body.String()}
}

func exchangeCatalog(t *testing.T, env embedEnv, mintBody string) catalogGET {
	t.Helper()
	return exchangeCatalogAs(t, env, env.admin, mintBody)
}

func exchangeCatalogAs(t *testing.T, env embedEnv, user identity.User, mintBody string) catalogGET {
	t.Helper()
	mintedRec := env.mintAs(t, user, mintBody)
	if mintedRec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", mintedRec.Code, mintedRec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(mintedRec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := postEmbedExchange(t, env, minted.Assertion)
	if ex.Code != http.StatusCreated {
		return catalogGET{ex: ex, assertion: minted.Assertion, body: ex.Body.String()}
	}
	token, csrf := sessionPair(t, ex)
	got := getEmbedCatalog(t, env, token, csrf)
	got.assertion = minted.Assertion
	got.ex = ex
	return got
}

func assertCatalogSecretFree(t *testing.T, body, assertion string) {
	t.Helper()
	if assertion != "" && strings.Contains(body, assertion) {
		t.Fatal("catalog leaked compact assertion")
	}
	lower := strings.ToLower(body)
	for _, leak := range []string{"begin private", `"d":`} {
		if strings.Contains(lower, leak) {
			t.Fatalf("catalog leaked %s", leak)
		}
	}
}
