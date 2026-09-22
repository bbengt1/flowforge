package httpapi

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/machine"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const machineTestSecret = "machine-secret-value-1"

func TestMachineMintDenyRotateRevokeAndNoEcho(t *testing.T) {
	var logs bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&logs, nil)))
	env := newMachineHTTP(t, log, machine.Consumers{})
	adminTok, adminCSRF := env.adminSession(t)

	rec := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals", `{
		"display_name":"Prometheus",
		"client_id":"prom-scrape",
		"secret":"`+machineTestSecret+`",
		"grants":[]
	}`, adminTok, adminCSRF))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	assertNoMachineSecret(t, rec)
	var created machine.View
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.ID == "" || created.ClientID != "prom-scrape" || created.DisplayName != "Prometheus" || len(created.Grants) != 0 {
		t.Fatalf("created view: %+v", created)
	}

	mint := env.token(t, "prom-scrape", machineTestSecret, "")
	assertNoMachineSecret(t, mint)
	var sess sessionResponse
	if err := json.Unmarshal(mint.Body.Bytes(), &sess); err != nil {
		t.Fatal(err)
	}
	if sess.Session.Embed != nil {
		t.Fatal("machine session must not be an embed session")
	}
	if sess.Principal.Issuer != machine.Issuer || sess.Principal.ExternalSubject != "prom-scrape" {
		t.Fatalf("principal: %+v", sess.Principal)
	}
	token, _ := sessionCookies(t, mint)

	metrics := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(metrics, req)
	assertProblem(t, metrics, http.StatusForbidden, CodeForbidden, "caller-request-16")

	ws := httptest.NewRecorder()
	wsReq := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	wsReq.Header.Set("Authorization", "Bearer "+token)
	wsReq.Header.Set(headerTenantSlug, "acme")
	wsReq.Header.Set(headerWorkbenchKey, "ops")
	wsReq.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(ws, wsReq)
	assertProblem(t, ws, http.StatusForbidden, CodeForbidden, "caller-request-16")

	adminList := env.do(t, sessionAPIRequest(http.MethodGet, "/api/v1/machine/principals", "", adminTok, adminCSRF))
	if adminList.Code != http.StatusOK {
		t.Fatalf("list: %d %s", adminList.Code, adminList.Body.String())
	}
	assertNoMachineSecret(t, adminList)

	self := httptest.NewRecorder()
	selfReq := httptest.NewRequest(http.MethodGet, "/api/v1/machine/principals", nil)
	selfReq.Header.Set("Authorization", "Bearer "+token)
	selfReq.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(self, selfReq)
	assertProblem(t, self, http.StatusForbidden, CodeForbidden, "caller-request-16")

	rotatedSecret := "machine-secret-value-2"
	rot := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals/"+created.ID+"/rotate", `{"secret":"`+rotatedSecret+`"}`, adminTok, adminCSRF))
	if rot.Code != http.StatusOK {
		t.Fatalf("rotate: %d %s", rot.Code, rot.Body.String())
	}
	assertNoMachineSecret(t, rot)
	assertNoMachineSecretText(t, rot.Body.String(), rotatedSecret)

	old := env.tokenStatus(t, "prom-scrape", machineTestSecret, "")
	if old != http.StatusUnauthorized {
		t.Fatalf("old secret status = %d", old)
	}
	mint2 := env.token(t, "prom-scrape", rotatedSecret, "")
	assertNoMachineSecretText(t, mint2.Body.String(), rotatedSecret)
	token2, _ := sessionCookies(t, mint2)

	rev := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals/"+created.ID+"/revoke", "", adminTok, adminCSRF))
	if rev.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rev.Code, rev.Body.String())
	}
	assertNoMachineSecretText(t, rev.Body.String(), rotatedSecret)
	var revoked machine.View
	if err := json.Unmarshal(rev.Body.Bytes(), &revoked); err != nil {
		t.Fatal(err)
	}
	if revoked.Status != machine.StatusRevoked {
		t.Fatalf("status %s", revoked.Status)
	}
	dead := httptest.NewRecorder()
	deadReq := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	deadReq.Header.Set("Authorization", "Bearer "+token2)
	deadReq.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(dead, deadReq)
	if dead.Code != http.StatusUnauthorized && dead.Code != http.StatusForbidden {
		t.Fatalf("revoked session: %d %s", dead.Code, dead.Body.String())
	}
	if env.tokenStatus(t, "prom-scrape", rotatedSecret, "") != http.StatusUnauthorized {
		t.Fatal("revoked principal still minted")
	}
	if strings.Contains(logs.String(), machineTestSecret) || strings.Contains(logs.String(), rotatedSecret) || strings.Contains(logs.String(), "$2a$") {
		t.Fatalf("logs leaked secret: %s", logs.String())
	}
}

func TestMachineMetricsGrantAndWorkspaceUnion(t *testing.T) {
	env := newMachineHTTP(t, nil, machine.Consumers{})
	adminTok, adminCSRF := env.adminSession(t)
	rec := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals", `{
		"display_name":"Automation",
		"client_id":"auto-bot",
		"secret":"`+machineTestSecret+`",
		"grants":["ops.metrics.read","workflow.execute"],
		"tenant_slug":"acme",
		"workbench_key":"ops"
	}`, adminTok, adminCSRF))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	assertNoMachineSecret(t, rec)
	mint := env.token(t, "auto-bot", machineTestSecret, "")
	token, _ := sessionCookies(t, mint)

	metrics := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/metrics", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	env.h.ServeHTTP(metrics, req)
	if metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), "flowforge_http_requests_total") {
		t.Fatalf("metrics: %d %s", metrics.Code, metrics.Body.String())
	}
	assertNoMachineSecret(t, metrics)

	ws := httptest.NewRecorder()
	wsReq := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	wsReq.Header.Set("Authorization", "Bearer "+token)
	wsReq.Header.Set(headerTenantSlug, "acme")
	wsReq.Header.Set(headerWorkbenchKey, "ops")
	env.h.ServeHTTP(ws, wsReq)
	if ws.Code != http.StatusOK || !strings.Contains(ws.Body.String(), authz.PermWorkflowExecute) {
		t.Fatalf("workspace: %d %s", ws.Code, ws.Body.String())
	}
	if strings.Contains(ws.Body.String(), authz.PermPlatformAdminister) {
		t.Fatalf("workspace grant included platform.administer: %s", ws.Body.String())
	}
	other := httptest.NewRecorder()
	otherReq := httptest.NewRequest(http.MethodGet, "/api/v1/workspace", nil)
	otherReq.Header.Set("Authorization", "Bearer "+token)
	otherReq.Header.Set(headerTenantSlug, "acme")
	otherReq.Header.Set(headerWorkbenchKey, "other")
	otherReq.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(other, otherReq)
	assertProblem(t, other, http.StatusForbidden, CodeForbidden, "caller-request-16")

	tenants := httptest.NewRecorder()
	tenReq := httptest.NewRequest(http.MethodPost, "/api/v1/tenants", strings.NewReader(`{"slug":"from-machine","name":"Nope"}`))
	tenReq.Header.Set("Content-Type", "application/json")
	tenReq.Header.Set("Authorization", "Bearer "+token)
	tenReq.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(tenants, tenReq)
	if tenants.Code == http.StatusCreated {
		t.Fatal("metrics grant must not bootstrap tenants")
	}
}

func TestMachineAssertionDistinctFromEmbedAndLogin(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	env := newMachineHTTP(t, nil, machine.Consumers{})
	adminTok, adminCSRF := env.adminSession(t)
	body := `{
		"display_name":"Signer",
		"client_id":"sign-bot",
		"assertion_public_key":"` + base64.StdEncoding.EncodeToString(pub) + `",
		"grants":["ops.metrics.read"]
	}`
	rec := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals", body, adminTok, adminCSRF))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), base64.StdEncoding.EncodeToString(pub)) {
		t.Fatalf("public key echoed: %s", rec.Body.String())
	}
	now := time.Date(2026, 9, 22, 15, 0, 0, 0, time.UTC)
	env.now = now
	assertion, err := machine.SignAssertion(priv, "sign-bot", now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	mint := env.token(t, "sign-bot", "", assertion)
	if mint.Code != http.StatusCreated {
		t.Fatalf("assertion mint: %d %s", mint.Code, mint.Body.String())
	}
	if strings.Contains(mint.Body.String(), assertion) {
		t.Fatal("assertion echoed in session response")
	}
	again := env.tokenStatus(t, "sign-bot", "", assertion)
	if again != http.StatusUnauthorized {
		t.Fatalf("replay status = %d", again)
	}

	login := httptest.NewRecorder()
	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/login", strings.NewReader(`{"identifier":"sign-bot","password":"`+machineTestSecret+`"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(login, loginReq)
	if login.Code == http.StatusCreated {
		t.Fatal("login must not mint a machine principal")
	}
	sessionReq := httptest.NewRecorder()
	sreq := httptest.NewRequest(http.MethodPost, "/api/v1/session", strings.NewReader(`{"issuer":"`+machine.Issuer+`","external_subject":"sign-bot"}`))
	sreq.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(sessionReq, sreq)
	if sessionReq.Code == http.StatusCreated {
		t.Fatal("trusted-dev session must not mint a machine principal when the flag is off")
	}
	ex := httptest.NewRecorder()
	exReq := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":"`+assertion+`","sdk":"embed.v1"}`))
	exReq.Header.Set("Content-Type", "application/json")
	env.h.ServeHTTP(ex, exReq)
	if ex.Code == http.StatusCreated {
		t.Fatal("embed exchange must not accept a machine assertion")
	}
}

func TestMachineConsumerFailClosed(t *testing.T) {
	consumers := machine.Consumers{
		Require:         []string{machine.ConsumerMetrics},
		MetricsClientID: "prom-scrape",
	}
	env := newMachineHTTP(t, nil, consumers)
	adminTok, adminCSRF := env.adminSession(t)

	denied := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodGet, "/api/v1/metrics", "", adminTok, adminCSRF)
	env.h.ServeHTTP(denied, req)
	assertProblem(t, denied, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")

	rec := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals", `{
		"display_name":"Prometheus",
		"client_id":"prom-scrape",
		"secret":"`+machineTestSecret+`"
	}`, adminTok, adminCSRF))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	still := httptest.NewRecorder()
	env.h.ServeHTTP(still, sessionAPIRequest(http.MethodGet, "/api/v1/metrics", "", adminTok, adminCSRF))
	assertProblem(t, still, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")

	// Grants are fixed at create. A second principal is unnecessary:
	// recreate is a conflict, so the healthy case uses a fresh handler.
	healthy := newMachineHTTP(t, nil, consumers)
	adminTok, adminCSRF = healthy.adminSession(t)
	okRec := healthy.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals", `{
		"display_name":"Prometheus",
		"client_id":"prom-scrape",
		"secret":"`+machineTestSecret+`",
		"grants":["ops.metrics.read"]
	}`, adminTok, adminCSRF))
	if okRec.Code != http.StatusCreated {
		t.Fatalf("healthy create: %d %s", okRec.Code, okRec.Body.String())
	}
	ready := httptest.NewRecorder()
	healthy.h.ServeHTTP(ready, sessionAPIRequest(http.MethodGet, "/api/v1/metrics", "", adminTok, adminCSRF))
	if ready.Code != http.StatusOK {
		t.Fatalf("healthy metrics: %d %s", ready.Code, ready.Body.String())
	}
	var created machine.View
	if err := json.Unmarshal(okRec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	rev := healthy.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals/"+created.ID+"/revoke", "", adminTok, adminCSRF))
	if rev.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", rev.Code, rev.Body.String())
	}
	after := httptest.NewRecorder()
	healthy.h.ServeHTTP(after, sessionAPIRequest(http.MethodGet, "/api/v1/metrics", "", adminTok, adminCSRF))
	assertProblem(t, after, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
}

func TestExplicitPlatformAdministerIsNotDefault(t *testing.T) {
	env := newMachineHTTP(t, nil, machine.Consumers{})
	adminTok, adminCSRF := env.adminSession(t)
	rec := env.do(t, sessionAPIRequest(http.MethodPost, "/api/v1/machine/principals", `{
		"display_name":"Break glass",
		"client_id":"break-glass",
		"secret":"`+machineTestSecret+`",
		"grants":["platform.administer"]
	}`, adminTok, adminCSRF))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	mint := env.token(t, "break-glass", machineTestSecret, "")
	token, csrf := sessionCookies(t, mint)
	got := httptest.NewRecorder()
	env.h.ServeHTTP(got, sessionAPIRequest(http.MethodGet, "/api/v1/machine/principals", "", token, csrf))
	if got.Code != http.StatusOK {
		t.Fatalf("explicit platform grant: %d %s", got.Code, got.Body.String())
	}
}

type machineHTTP struct {
	h        http.Handler
	store    *identity.Memory
	sessions session.Store
	now      time.Time
}

func newMachineHTTP(t *testing.T, log *slog.Logger, consumers machine.Consumers) *machineHTTP {
	t.Helper()
	store := identity.NewMemory()
	sessions := session.NewMemory()
	ctx := context.Background()
	admin, err := store.UpsertUser(ctx, "https://idp.example", "admin-1", "Admin")
	if err != nil {
		t.Fatal(err)
	}
	tenant, err := store.CreateTenant(ctx, "acme", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, tenant.ID, "ops", "Ops", admin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateWorkspace(ctx, tenant.ID, "other", "Other", admin.ID); err != nil {
		t.Fatal(err)
	}
	env := &machineHTTP{
		store:    store,
		sessions: sessions,
		now:      time.Date(2026, 9, 22, 15, 0, 0, 0, time.UTC),
	}
	env.h = NewWithDeps(Deps{
		Store:            store,
		Sessions:         sessions,
		Machines:         machine.NewMemory(),
		MachineConsumers: consumers,
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  "https://idp.example",
			Subject: "admin-1",
		}},
		Security: Security{TrustIdentityHeaders: false},
		Log:      log,
		Now:      func() time.Time { return env.now },
	})
	return env
}

func (e *machineHTTP) adminSession(t *testing.T) (string, string) {
	t.Helper()
	user, err := e.store.UpsertUser(t.Context(), "https://idp.example", "admin-1", "Admin")
	if err != nil {
		t.Fatal(err)
	}
	issued, err := e.sessions.Create(t.Context(), user.ID, e.now, 30*time.Minute, 12*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return issued.Token, issued.CSRF
}

func (e *machineHTTP) do(t *testing.T, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	e.h.ServeHTTP(rec, req)
	return rec
}

func (e *machineHTTP) token(t *testing.T, clientID, secret, assertion string) *httptest.ResponseRecorder {
	t.Helper()
	rec := e.tokenRequest(t, clientID, secret, assertion)
	if rec.Code != http.StatusCreated {
		t.Fatalf("token: %d %s", rec.Code, rec.Body.String())
	}
	return rec
}

func (e *machineHTTP) tokenStatus(t *testing.T, clientID, secret, assertion string) int {
	t.Helper()
	return e.tokenRequest(t, clientID, secret, assertion).Code
}

func (e *machineHTTP) tokenRequest(t *testing.T, clientID, secret, assertion string) *httptest.ResponseRecorder {
	t.Helper()
	body := map[string]string{"client_id": clientID}
	if secret != "" {
		body["secret"] = secret
	}
	if assertion != "" {
		body["assertion"] = assertion
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/machine/token", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return e.do(t, req)
}

func assertNoMachineSecret(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	var b strings.Builder
	b.WriteString(rec.Body.String())
	b.WriteString(rec.Header().Get("Set-Cookie"))
	assertNoMachineSecretText(t, b.String(), machineTestSecret)
}

func assertNoMachineSecretText(t *testing.T, text, secret string) {
	t.Helper()
	if secret != "" && strings.Contains(text, secret) {
		t.Fatalf("response echoed secret material")
	}
	if strings.Contains(text, "$2a$") || strings.Contains(text, "$2b$") {
		t.Fatalf("response echoed a password hash")
	}
}
