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

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/isolation"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/opsconfig"
	"github.com/bbengt1/flowforge/apps/api/internal/portal"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
	"github.com/bbengt1/flowforge/apps/api/internal/webhook"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const portalIssuer = "https://portal.cp-ops.example"

type portalEnv struct {
	embedEnv
}

func newPortalEnv(t *testing.T) portalEnv {
	t.Helper()
	return newPortalEnvWithIssuers(t, []string{portalIssuer})
}

func newPortalEnvWithIssuers(t *testing.T, issuers []string) portalEnv {
	t.Helper()
	now := time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC)
	clock := &now
	keys := embed.TestMaterial()
	store := identity.NewMemory()
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:         store,
		Scoped:        isolation.NewMemory(),
		Sessions:      session.NewMemory(),
		Workflows:     wfstore.NewMemory(),
		Ops:           opsconfig.NewMemory(),
		Hooks:         webhook.NewMemory(),
		Vault:         vault.NewMemory(vault.TestKeys(), nil),
		Keys:          vault.TestKeys(),
		EmbedKeys:     keys,
		EmbedJTI:      embed.NewMemoryJTI(),
		PortalIssuers: issuers,
		Now:           func() time.Time { return *clock },
		Log:           log,
	}))
	admin := identity.User{Issuer: portalIssuer, ExternalSubject: "portal-svc", DisplayName: "Portal"}
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
	return portalEnv{embedEnv: embedEnv{h: h, store: store, keys: keys, now: clock, admin: current.Principal, logs: &buf}}
}

func (e portalEnv) mintPortal(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/portal/adapter/assertions", body, e.admin)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e portalEnv) exchange(t *testing.T, assertion string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, assertion)+`,"sdk":"embed.v1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	e.h.ServeHTTP(rec, req)
	return rec
}

func TestPortalAdapterCatalog(t *testing.T) {
	env := newPortalEnv(t)
	rec := httptest.NewRecorder()
	env.h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/portal/adapter", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	var cat portal.Catalog
	if err := json.Unmarshal(rec.Body.Bytes(), &cat); err != nil {
		t.Fatal(err)
	}
	if cat.Adapter != portal.AdapterVersion || cat.SDK != embed.SDKVersion || cat.Audience != embed.DefaultAudience {
		t.Fatalf("catalog %+v", cat)
	}
	if cat.Boundary.SharesDatabase || cat.Boundary.SharesExecutor || cat.Boundary.ParallelAuthPath {
		t.Fatalf("boundary %+v", cat.Boundary)
	}
	if cat.Boundary.PortalEntryIsAuthorization {
		t.Fatal("portal entry must not be FlowForge authz")
	}
	if cat.MountPrefix != "/embed/v1" {
		t.Fatalf("mount %s", cat.MountPrefix)
	}
	if !strings.Contains(rec.Body.String(), portalIssuer) {
		t.Fatal("catalog should list configured portal issuer")
	}
	if strings.Contains(rec.Body.String(), "DATABASE_URL") || strings.Contains(rec.Body.String(), "BEGIN PRIVATE") {
		t.Fatal("catalog leaked secrets")
	}
}

func TestPortalMintMapsRolesAndExchanges(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["portal.viewer"],"subject":"portal-user-1"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	if minted.Audience != embed.DefaultAudience || minted.Issuer != portalIssuer {
		t.Fatalf("minted %+v", minted)
	}
	if minted.SDK != embed.SDKVersion {
		t.Fatalf("sdk %s", minted.SDK)
	}
	if !contains(minted.Capabilities, authz.PermWorkflowView) {
		t.Fatalf("caps %v", minted.Capabilities)
	}
	if contains(minted.Capabilities, authz.PermWorkspaceAdminister) {
		t.Fatal("viewer must not administer")
	}

	ex := env.exchange(t, minted.Assertion)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange %d %s", ex.Code, ex.Body.String())
	}
	if strings.Contains(ex.Body.String(), minted.Assertion) {
		t.Fatal("exchange echoed assertion")
	}
	var exchanged embedExchangeResponse
	if err := json.Unmarshal(ex.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.Embed == nil || exchanged.Session.Embed.WorkbenchKey != "ops" {
		t.Fatalf("session embed %+v", exchanged.Session.Embed)
	}
}

func TestPortalMintEmptyAllowlistDenied(t *testing.T) {
	env := newPortalEnvWithIssuers(t, nil)
	rec := env.mintPortal(t, `{"portalRoles":["viewer"]}`)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if !strings.Contains(rec.Body.String(), "allowlist") {
		t.Fatalf("detail should mention allowlist: %s", rec.Body.String())
	}
}

func TestPortalExchangeEmptyAllowlistDenied(t *testing.T) {
	env := newPortalEnvWithIssuers(t, nil)
	now := *env.now
	token := signClaims(t, env.keys, embed.Claims{
		Issuer:       portalIssuer,
		Audience:     embed.DefaultAudience,
		Subject:      "portal-svc",
		NotBefore:    now.Unix(),
		ExpiresAt:    now.Add(time.Minute).Unix(),
		TokenID:      "eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee",
		TenantID:     tenantID(t, env.embedEnv),
		WorkbenchKey: "ops",
		Capabilities: []string{"workflow.view"},
		SDK:          embed.SDKVersion,
	})
	ex := env.exchange(t, token)
	assertProblem(t, ex, http.StatusForbidden, CodeForbidden, "")
}

func TestPortalHostileIssuerFailsClosed(t *testing.T) {
	env := newPortalEnv(t)
	hostile := identity.User{Issuer: "https://hostile.example", ExternalSubject: "attacker", DisplayName: "Hostile"}
	seedWorkspace(t, env.store, hostile, "evil", "ops", "Evil")

	rec := httptest.NewRecorder()
	req := identifiedJSON(http.MethodPost, "/api/v1/portal/adapter/assertions", `{"portalRoles":["viewer"]}`, hostile)
	req.Header.Set(headerTenantSlug, "evil")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "")
	if strings.Contains(rec.Body.String(), "BEGIN") {
		t.Fatal("problem leaked key material")
	}
}

func TestPortalUnknownRoleFailsClosed(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["portal.root"]}`)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "")
}

func TestPortalReplayFailsClosed(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["viewer"]}`)
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	first := env.exchange(t, minted.Assertion)
	if first.Code != http.StatusCreated {
		t.Fatalf("first %d %s", first.Code, first.Body.String())
	}
	second := env.exchange(t, minted.Assertion)
	assertProblem(t, second, http.StatusConflict, CodeConflict, "")
}

func TestPortalCrossTenantWorkbenchFailsClosed(t *testing.T) {
	env := newPortalEnv(t)
	seedWorkspace(t, env.store, env.admin, "acme", "other", "Other")

	rec := env.mintPortal(t, `{"portalRoles":["viewer"]}`)
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := env.exchange(t, minted.Assertion)
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
	req := portalSessionRequest(http.MethodGet, "/api/v1/workspace", token, csrf)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "other")
	env.h.ServeHTTP(wrong, req)
	if wrong.Code != http.StatusForbidden && wrong.Code != http.StatusBadRequest {
		t.Fatalf("cross-workbench %d %s", wrong.Code, wrong.Body.String())
	}
}

func TestPortalEntryIsNotFlowForgeAuthorization(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["portal.admin"],"subject":"portal-guest"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := env.exchange(t, minted.Assertion)
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
	denied := httptest.NewRecorder()
	req := portalSessionRequest(http.MethodGet, "/api/v1/workspace", token, csrf)
	req.Header.Set(headerTenantSlug, "acme")
	req.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(denied, req)
	if denied.Code != http.StatusForbidden && denied.Code != http.StatusUnauthorized {
		t.Fatalf("guest portal-admin should not pass FlowForge membership: %d %s", denied.Code, denied.Body.String())
	}
}

func TestPortalNoCredentialOrRawLogExposure(t *testing.T) {
	env := newPortalEnv(t)
	ws, tenant := currentWorkspace(t, env.h, env.admin)
	created := createVaultCredential(t, env.h, env.admin, tenant, ws, "token", "PortalCred", map[string]string{
		"token": vaultPlaintext,
	})

	wf := createWorkflow(t, env.h, env.admin, tenant, ws, coreNeutralExecutionYAML)
	pub := publishWorkflow(t, env.h, env.admin, tenant, ws, wf.Workflow.ID, wf.Draft.Revision, "e113")
	exec := startExecution(t, env.h, env.admin, tenant, ws, wf.Workflow.ID, pub.Version.ID)
	detail := fetchExecutionDetail(t, env.h, env.admin, tenant, ws, exec.ID)
	if len(detail.Steps) == 0 {
		t.Fatal("expected a step")
	}
	stepID := detail.Steps[0].ID
	upload, _ := json.Marshal(map[string]any{
		"kind":                  "log",
		"filename":              "runner.log",
		"contentType":           "text/plain",
		"contentClassification": "internal",
		"content":               "ok\nAuthorization: Bearer " + vaultPlaintext + "\n",
	})
	up := httptest.NewRecorder()
	req := workspaceJSON(http.MethodPost, "/api/v1/executions/"+exec.ID+"/steps/"+stepID+"/logs", upload, env.admin, tenant, ws)
	env.h.ServeHTTP(up, req)
	if up.Code != http.StatusCreated {
		t.Fatalf("upload logs %d %s", up.Code, up.Body.String())
	}
	if strings.Contains(up.Body.String(), vaultPlaintext) {
		t.Fatal("upload echoed raw log secret")
	}

	rec := env.mintPortal(t, `{"portalRoles":["portal.operator","portal.admin"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := env.exchange(t, minted.Assertion)
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

	credRec := httptest.NewRecorder()
	creq := portalSessionRequest(http.MethodGet, "/api/v1/credentials/"+created.ID, token, csrf)
	creq.Header.Set(headerTenantID, tenant.ID)
	creq.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	env.h.ServeHTTP(credRec, creq)
	if credRec.Code != http.StatusOK {
		t.Fatalf("credential %d %s", credRec.Code, credRec.Body.String())
	}
	assertNoPlaintext(t, credRec.Body.Bytes(), vaultPlaintext)

	logRec := httptest.NewRecorder()
	lreq := portalSessionRequest(http.MethodGet, "/api/v1/executions/"+exec.ID+"/steps/"+stepID+"/logs?limit=10", token, csrf)
	lreq.Header.Set(headerTenantID, tenant.ID)
	lreq.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	env.h.ServeHTTP(logRec, lreq)
	if logRec.Code != http.StatusOK {
		t.Fatalf("logs %d %s", logRec.Code, logRec.Body.String())
	}
	if strings.Contains(logRec.Body.String(), vaultPlaintext) {
		t.Fatal("raw log secret exposed through portal session")
	}

	out := env.logs.String()
	if strings.Contains(out, minted.Assertion) || strings.Contains(out, vaultPlaintext) {
		t.Fatal("assertion or credential leaked into logs")
	}
	if strings.Contains(out, embed.EncodeSeedB64(env.keys.Private)) {
		t.Fatal("signing seed leaked into logs")
	}
}

func TestPortalHostWorkspaceIDRejected(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["viewer"],"workspaceId":"33333333-3333-4333-8333-333333333333"}`)
	if rec.Code != http.StatusForbidden && rec.Code != http.StatusBadRequest {
		t.Fatalf("host workspace id %d %s", rec.Code, rec.Body.String())
	}
}

func portalSessionRequest(method, path, token, csrf string) *http.Request {
	req := httptest.NewRequest(method, path, nil)
	req.AddCookie(&http.Cookie{Name: session.CookieName, Value: token})
	req.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func TestPortalSecretFreeLogs(t *testing.T) {
	env := newPortalEnv(t)
	rec := env.mintPortal(t, `{"portalRoles":["viewer"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var minted embed.Minted
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	out := env.logs.String()
	if strings.Contains(out, minted.Assertion) {
		t.Fatal("assertion leaked into logs")
	}
	if !strings.Contains(out, "portal.minted") {
		t.Fatalf("expected portal audit: %s", out)
	}
}
