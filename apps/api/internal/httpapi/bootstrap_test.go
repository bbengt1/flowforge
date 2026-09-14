package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/embed"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/postgres"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

func TestBootstrapIncompleteAllowsUnauthenticatedGET(t *testing.T) {
	store := bootstrap.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, Security: Security{}})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("incomplete GET: %d %s", rec.Code, rec.Body.String())
	}
	status := decodeBootstrapStatus(t, rec)
	if status.Complete || !status.Incomplete {
		t.Fatalf("want incomplete: %+v", status)
	}
	if !status.StandaloneOnly {
		t.Fatal("standaloneOnly must be true")
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapCompleteRequiresAuth(t *testing.T) {
	boot := bootstrap.NewMemory()
	if err := boot.MarkSeedSkip(t.Context(), bootstrap.SeedSkip{}); err != nil {
		t.Fatal(err)
	}
	idStore := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(Deps{
		Store:          idStore,
		Sessions:       sessions,
		Bootstrap:      boot,
		Security:       Security{},
		PlatformAdmins: []authz.PrincipalRef{{Issuer: httpTestIssuer, Subject: httpTestSubject}},
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	_, issued := issueTestSession(t, idStore, sessions, httpTestIssuer, httpTestSubject, "Admin")
	rec = httptest.NewRecorder()
	req = sessionAPIRequest(http.MethodGet, "/api/v1/bootstrap", "", issued.Token, issued.CSRF)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("authenticated complete GET: %d %s", rec.Code, rec.Body.String())
	}
	status := decodeBootstrapStatus(t, rec)
	if !status.Complete || status.Incomplete {
		t.Fatalf("want complete: %+v", status)
	}
	if !status.Skipped {
		t.Fatal("seed skip must set skipped")
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapTrustedDevSeedSkip(t *testing.T) {
	idStore := identity.NewMemory()
	boot := bootstrap.NewMemory()
	keys := vault.TestKeys()
	res, err := localseed.Apply(t.Context(), localseed.Input{
		Store:          idStore,
		Vault:          vault.NewMemory(keys, nil),
		Keys:           keys,
		PlatformAdmins: []authz.PrincipalRef{{Issuer: httpTestIssuer, Subject: httpTestSubject}},
		Bootstrap:      boot,
		PublicBaseURL:  "http://localhost:3000",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Users) == 0 {
		t.Fatal("seed must create admin")
	}

	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Complete || !st.FirstAdminReady || !st.PublicURLReady || st.PublicBaseURL != "http://localhost:3000" {
		t.Fatalf("localseed skip %+v", st)
	}

	h := NewWithDeps(Deps{
		Store:          idStore,
		Bootstrap:      boot,
		Sessions:       session.NewMemory(),
		Security:       Security{TrustIdentityHeaders: true},
		PlatformAdmins: []authz.PrincipalRef{{Issuer: httpTestIssuer, Subject: httpTestSubject}},
	})
	rec := httptest.NewRecorder()
	req := identifiedRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("trusted-dev complete GET: %d %s", rec.Code, rec.Body.String())
	}
	status := decodeBootstrapStatus(t, rec)
	if !status.Complete || status.Incomplete {
		t.Fatalf("seed must skip wizard: %+v", status)
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapDoesNotGateEmbedHandlers(t *testing.T) {
	boot := bootstrap.NewMemory() // incomplete
	idStore := identity.NewMemory()
	keys := embed.TestMaterial()
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:        idStore,
		Sessions:     session.NewMemory(),
		Bootstrap:    boot,
		EmbedKeys:    keys,
		EmbedJTI:     embed.NewMemoryJTI(),
		EmbedIssuers: []string{"https://idp.example"},
	}))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/embed/catalog", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("embed catalog while bootstrap incomplete: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"/bootstrap"`) {
		t.Fatal("embed catalog must not publish the standalone bootstrap gate")
	}

	if err := boot.MarkSeedSkip(t.Context(), bootstrap.SeedSkip{}); err != nil {
		t.Fatal(err)
	}
	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/embed/catalog", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("embed catalog while bootstrap complete: %d %s", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/embed/jwks", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("embed jwks while bootstrap complete: %d %s", rec.Code, rec.Body.String())
	}
}

func TestBootstrapMethodNotAllowedAndNoSecrets(t *testing.T) {
	h := NewWithDeps(Deps{Bootstrap: bootstrap.NewMemory()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap", strings.NewReader(`{"password":"should-not-appear","kek":"nope"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "caller-request-16")
	if strings.Contains(rec.Body.String(), "should-not-appear") {
		t.Fatal("problem must not echo request body")
	}
	if rec.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("Allow = %q", rec.Header().Get("Allow"))
	}
}

func TestBootstrapPersistenceConfirmSetsReady(t *testing.T) {
	store := bootstrap.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, DB: readyPersistenceDB(), Security: Security{}})

	rec := httptest.NewRecorder()
	req := persistenceConfirmRequest()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("confirm: %d %s", rec.Code, rec.Body.String())
	}
	status := decodeBootstrapStatus(t, rec)
	if status.Complete || !status.Incomplete {
		t.Fatalf("must not mark complete: %+v", status)
	}
	if !status.Steps.Persistence.Ready {
		t.Fatalf("persistence must be ready: %+v", status.Steps)
	}
	if status.Steps.FirstAdmin.Ready || status.Steps.PublicURL.Ready || status.Steps.TLS.Ready {
		t.Fatalf("later steps must stay unreadied: %+v", status.Steps)
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !st.PersistenceReady || st.Complete {
		t.Fatalf("store after SetStep: %+v", st)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status GET: %d %s", rec.Code, rec.Body.String())
	}
	got := decodeBootstrapStatus(t, rec)
	if !got.Steps.Persistence.Ready || got.Complete {
		t.Fatalf("GET must reflect persistence ready: %+v", got)
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapPersistenceDBDownIs503(t *testing.T) {
	store := bootstrap.NewMemory()
	h := NewWithDeps(Deps{
		Bootstrap: store,
		DB: ReadyChecker(func(context.Context) error {
			return postgres.ErrUnavailable
		}),
		Security: Security{},
	})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, persistenceConfirmRequest())
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
	if strings.Contains(strings.ToLower(rec.Body.String()), "password") {
		t.Fatal("503 must not mention secrets")
	}

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.PersistenceReady || st.Complete {
		t.Fatalf("fail closed must not set ready: %+v", st)
	}
}

func TestBootstrapPersistenceNilDBIs503(t *testing.T) {
	store := bootstrap.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, Security: Security{}})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, persistenceConfirmRequest())
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.PersistenceReady {
		t.Fatal("nil DB must not set persistence ready")
	}
}

func TestBootstrapPersistenceCompleteIs409(t *testing.T) {
	store := bootstrap.NewMemory()
	if err := store.MarkSeedSkip(t.Context(), bootstrap.SeedSkip{}); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(Deps{Bootstrap: store, DB: readyPersistenceDB(), Security: Security{}})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, persistenceConfirmRequest())
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")
	if !strings.Contains(rec.Body.String(), "Settings") {
		t.Fatalf("complete reject should point at Settings: %s", rec.Body.String())
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapPersistenceRejectsSecretsAndInvalidConfirm(t *testing.T) {
	store := bootstrap.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, DB: readyPersistenceDB(), Security: Security{}})

	secretBody := `{"confirm":true,"password":"super-secret","DATABASE_URL":"postgres://user:hunter2@db/ff"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/persistence", strings.NewReader(secretBody))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if strings.Contains(rec.Body.String(), "super-secret") || strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatal("problem must not echo credentials")
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/persistence", strings.NewReader(`{"confirm":false}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.PersistenceReady {
		t.Fatal("invalid body must not set persistence ready")
	}
}

func TestBootstrapPersistenceEmbedSessionForbidden(t *testing.T) {
	env := newEmbedEnv(t)
	token, csrf := exchangeEmbedSession(t, env, env.ops, []string{authz.PermWorkflowView})

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/bootstrap/persistence", `{"confirm":true}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
	if !strings.Contains(rec.Body.String(), "standalone") {
		t.Fatalf("embed deny should mention standalone wizard: %s", rec.Body.String())
	}
}

func TestBootstrapPersistenceMethodNotAllowed(t *testing.T) {
	h := NewWithDeps(Deps{Bootstrap: bootstrap.NewMemory(), DB: readyPersistenceDB()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap/persistence", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "caller-request-16")
}

func TestBootstrapAdminsCreatesWorkspaceAdminAndSetsReady(t *testing.T) {
	store := bootstrap.NewMemory()
	if err := store.SetStep(t.Context(), bootstrap.StepPersistence, true); err != nil {
		t.Fatal(err)
	}
	idStore := identity.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, Store: idStore, Security: Security{}})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1","display_name":"Operator"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("create admin: %d %s", rec.Code, rec.Body.String())
	}
	status := decodeBootstrapStatus(t, rec)
	if status.Complete || !status.Incomplete {
		t.Fatalf("must not mark complete: %+v", status)
	}
	if !status.Steps.Persistence.Ready || !status.Steps.FirstAdmin.Ready {
		t.Fatalf("persistence + firstAdmin must be ready: %+v", status.Steps)
	}
	if status.Steps.PublicURL.Ready || status.Steps.TLS.Ready {
		t.Fatalf("later steps must stay unreadied: %+v", status.Steps)
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if !st.FirstAdminReady || st.Complete {
		t.Fatalf("store after SetStep: %+v", st)
	}

	user, err := idStore.UpsertUser(t.Context(), "https://idp.example", "admin-1", "Operator")
	if err != nil {
		t.Fatal(err)
	}
	memberships, err := idStore.ListWorkspacesForUser(t.Context(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) != 1 || !authz.Allows(memberships[0].Permissions, authz.PermWorkspaceAdminister) {
		t.Fatalf("first admin must be workspace admin: %+v", memberships)
	}

	rec = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status GET: %d %s", rec.Code, rec.Body.String())
	}
	got := decodeBootstrapStatus(t, rec)
	if !got.Steps.FirstAdmin.Ready || got.Complete {
		t.Fatalf("GET must reflect firstAdmin ready: %+v", got)
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapAdminsRejectsWithoutPersistenceReady(t *testing.T) {
	store := bootstrap.NewMemory()
	idStore := identity.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, Store: idStore, Security: Security{}})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1"}`))
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")
	if !strings.Contains(rec.Body.String(), "Persistence") {
		t.Fatalf("fail-closed order should mention persistence: %s", rec.Body.String())
	}

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.FirstAdminReady || st.Complete {
		t.Fatalf("must not set firstAdmin: %+v", st)
	}
	if idStore.HasPrincipal("https://idp.example", "admin-1") {
		t.Fatal("must not upsert a user when persistence is not ready")
	}
}

func TestBootstrapAdminsCompleteIs409(t *testing.T) {
	store := bootstrap.NewMemory()
	if err := store.MarkSeedSkip(t.Context(), bootstrap.SeedSkip{}); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(Deps{Bootstrap: store, Store: identity.NewMemory(), Security: Security{}})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1"}`))
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")
	if !strings.Contains(rec.Body.String(), "Settings") {
		t.Fatalf("complete reject should point at Settings: %s", rec.Body.String())
	}
	assertBootstrapBodyHasNoSecrets(t, rec.Body.Bytes())
}

func TestBootstrapAdminsNeverEchoesPassword(t *testing.T) {
	store := bootstrap.NewMemory()
	if err := store.SetStep(t.Context(), bootstrap.StepPersistence, true); err != nil {
		t.Fatal(err)
	}
	idStore := identity.NewMemory()
	h := NewWithDeps(Deps{Bootstrap: store, Store: idStore, Security: Security{}})

	secretBody := `{"issuer":"https://idp.example","external_subject":"admin-1","password":"super-secret-hunter2"}`
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, firstAdminRequest(secretBody))
	assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if strings.Contains(rec.Body.String(), "super-secret-hunter2") {
		t.Fatal("problem must not echo credentials")
	}

	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.FirstAdminReady {
		t.Fatal("rejected credential body must not set firstAdmin ready")
	}
	if idStore.HasPrincipal("https://idp.example", "admin-1") {
		t.Fatal("must not upsert a user when credentials are rejected")
	}
}

func TestBootstrapAdminsEmbedSessionForbidden(t *testing.T) {
	env := newEmbedEnv(t)
	token, csrf := exchangeEmbedSession(t, env, env.ops, []string{authz.PermWorkflowView})

	rec := httptest.NewRecorder()
	req := sessionAPIRequest(http.MethodPost, "/api/v1/bootstrap/admins", `{"issuer":"https://idp.example","external_subject":"admin-1"}`, token, csrf)
	env.h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
	if !strings.Contains(rec.Body.String(), "standalone") {
		t.Fatalf("embed deny should mention standalone wizard: %s", rec.Body.String())
	}
}

func TestBootstrapAdminsMethodNotAllowed(t *testing.T) {
	h := NewWithDeps(Deps{Bootstrap: bootstrap.NewMemory(), Store: identity.NewMemory()})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap/admins", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusMethodNotAllowed, CodeMethodNotAllowed, "caller-request-16")
}

func TestBootstrapAdminsStoreDownIs503(t *testing.T) {
	h := NewWithDeps(Deps{Bootstrap: unavailableBootstrap{}, Store: identity.NewMemory(), Security: Security{}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1"}`))
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
}

func TestBootstrapPersistenceStoreDownIs503(t *testing.T) {
	h := NewWithDeps(Deps{Bootstrap: unavailableBootstrap{}, DB: readyPersistenceDB(), Security: Security{}})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, persistenceConfirmRequest())
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
}

func readyPersistenceDB() postgres.Checker {
	return ReadyChecker(func(context.Context) error { return nil })
}

func persistenceConfirmRequest() *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/persistence", strings.NewReader(`{"confirm":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func firstAdminRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/admins", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

type unavailableBootstrap struct{}

func (unavailableBootstrap) Get(context.Context) (bootstrap.State, error) {
	return bootstrap.State{}, bootstrap.ErrUnavailable
}
func (unavailableBootstrap) SetStep(context.Context, string, bool) error {
	return bootstrap.ErrUnavailable
}
func (unavailableBootstrap) SetPublicURL(context.Context, string) error {
	return bootstrap.ErrUnavailable
}
func (unavailableBootstrap) SetTLS(context.Context, bool, string) error {
	return bootstrap.ErrUnavailable
}
func (unavailableBootstrap) MarkComplete(context.Context) error {
	return bootstrap.ErrUnavailable
}
func (unavailableBootstrap) MarkSeedSkip(context.Context, bootstrap.SeedSkip) error {
	return bootstrap.ErrUnavailable
}

func decodeBootstrapStatus(t *testing.T, rec *httptest.ResponseRecorder) bootstrap.Status {
	t.Helper()
	var status bootstrap.Status
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func assertBootstrapBodyHasNoSecrets(t *testing.T, body []byte) {
	t.Helper()
	lower := strings.ToLower(string(body))
	for _, secret := range []string{
		"password", "kek", "privatekey", "private_key", "ciphertext",
		"publicbaseurl", "public_base_url", "-----begin",
	} {
		if strings.Contains(lower, secret) {
			t.Fatalf("bootstrap response contains %q: %s", secret, body)
		}
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"password", "kek", "secret", "privateKey", "token", "pem",
		"publicBaseUrl", "public_base_url", "hash",
	} {
		if _, ok := raw[key]; ok {
			t.Fatalf("bootstrap response has secret field %q", key)
		}
	}
}
