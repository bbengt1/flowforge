package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

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
	h     http.Handler
	keys  embed.Material
	now   *time.Time
	admin identity.User
	logs  *bytes.Buffer
}

func newEmbedEnv(t *testing.T) embedEnv {
	t.Helper()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := &now
	keys := embed.TestMaterial()
	store := identity.NewMemory()
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	h := NewWithDeps(Deps{
		Store:     store,
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
		Log:       log,
	})
	admin := identity.User{Issuer: "https://idp.example", ExternalSubject: "admin-1", DisplayName: "Admin"}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/tenants", `{"slug":"acme","name":"Acme"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create tenant: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"ops","name":"Ops"}`, admin)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create workspace: %d %s", rec.Code, rec.Body.String())
	}
	rec = httptest.NewRecorder()
	req = identifiedRequest(http.MethodGet, "/api/v1/workspace", nil)
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
	return embedEnv{h: h, keys: keys, now: clock, admin: current.Principal, logs: &buf}
}

func (e embedEnv) advance(d time.Duration) {
	*e.now = e.now.Add(d)
}

func (e embedEnv) mint(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/assertions", body, e.admin)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	e.h.ServeHTTP(rec, req)
	return rec
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
	if !strings.Contains(rec.Body.String(), `"/embed/v1/workflows/{id}"`) {
		t.Fatal("missing embed deep link")
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

func TestEmbedExchangeCrossTenantWorkbenchRejected(t *testing.T) {
	env := newEmbedEnv(t)
	other := identifiedJSON(http.MethodPost, "/api/v1/workspaces", `{"tenant_slug":"acme","workbench_key":"other","name":"Other"}`, env.admin)
	otherRec := httptest.NewRecorder()
	env.h.ServeHTTP(otherRec, other)
	if otherRec.Code != http.StatusCreated {
		t.Fatalf("other workspace %d %s", otherRec.Code, otherRec.Body.String())
	}

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

func TestEmbedKeyRotationOverlapAndUnknownKid(t *testing.T) {
	env := newEmbedEnv(t)
	old := embed.NewEphemeralMaterial()
	old.KeyID = "retired-kid"
	jwk := embed.PublicJWK{
		Kty: embed.KeyType, Crv: embed.Curve, Kid: old.KeyID,
		X: encodeEmbedPub(old), Use: "sig", Alg: embed.Algorithm, Status: embed.KeyStatusOverlap,
	}
	body, err := json.Marshal(map[string]any{"action": "register-overlap", "publicJwk": jwk})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/embed/keys/rotate", string(body), env.admin)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("rotate %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), old.KeyID) {
		t.Fatal("jwks should publish overlap kid")
	}
	if strings.Contains(rec.Body.String(), `"d"`) || strings.Contains(rec.Body.String(), embed.EncodeSeedB64(old.Private)) {
		t.Fatal("private key leaked from rotate")
	}

	now := *env.now
	token, _, err := embed.Mint(old, embed.MintInput{
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

	foreign := embed.NewEphemeralMaterial()
	foreign.KeyID = "unknown-kid"
	bad, _, err := embed.Mint(foreign, embed.MintInput{
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
	req = httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, bad.Assertion)+`}`))
	req.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(rej, req)
	assertProblem(t, rej, http.StatusUnauthorized, CodeUnauthenticated, "")
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
