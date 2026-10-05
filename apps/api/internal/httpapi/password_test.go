package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

func assertNoPasswordField(t *testing.T, body string) {
	t.Helper()
	if strings.Contains(body, `"password"`) || strings.Contains(body, `"password_hash"`) {
		t.Fatalf("response must not include a password field: %s", body)
	}
	if strings.Contains(body, "$2a$") || strings.Contains(body, "$2b$") {
		t.Fatal("response must not include a bcrypt hash")
	}
}

// adminResetPassword is a real secret used when a test needs the
// administrator-initiated must_change_password gate. The seeded admin
// has no usable password.
const adminResetPassword = "temporary-pass"

func seedMustChangeAdmin(t *testing.T, store *identity.Memory) {
	t.Helper()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), localauth.OneTimeIdentifier)
	if err != nil {
		t.Fatal(err)
	}
	hash, err := localauth.HashPassword(adminResetPassword)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), cred.User.ID, cred.Identifier, hash); err != nil {
		t.Fatal(err)
	}
	if err := store.RequireLocalPasswordChange(t.Context(), cred.User.ID); err != nil {
		t.Fatal(err)
	}
}

func TestBootstrapLoginRejectsRetiredDefault(t *testing.T) {
	store, h := newLoginEnv(t)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if cred.MustChangePassword || localauth.PasswordHashUsable(cred.PasswordHash) {
		t.Fatalf("seed must have no usable password: %+v", cred)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin","password":"admin"}`))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if !strings.Contains(rec.Body.String(), invalidCredentialsDetail) {
		t.Fatalf("retired pair: %s", rec.Body.String())
	}
	assertNoPasswordField(t, rec.Body.String())
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("retired pair must not mint ff_session")
		}
	}
}

func TestChangePasswordClearsFlagAndKillsOneTime(t *testing.T) {
	store, h := newLoginEnv(t)
	seedMustChangeAdmin(t, store)

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"Admin","password":"`+adminResetPassword+`"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)
	rotated := "correct-horse"

	change := httptest.NewRecorder()
	h.ServeHTTP(change, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"`+rotated+`"}`, token, csrf))
	if change.Code != http.StatusOK {
		t.Fatalf("change-password: %d %s", change.Code, change.Body.String())
	}
	if strings.Contains(change.Body.String(), rotated) {
		t.Fatal("change-password must not echo the new password")
	}
	assertNoPasswordField(t, change.Body.String())
	var after sessionResponse
	if err := json.Unmarshal(change.Body.Bytes(), &after); err != nil {
		t.Fatal(err)
	}
	if after.Session.MustChangePassword {
		t.Fatal("success must clear must_change_password")
	}

	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", get.Code, get.Body.String())
	}
	var current sessionResponse
	if err := json.Unmarshal(get.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if current.Session.MustChangePassword {
		t.Fatal("GET /session must stay cleared after change")
	}

	reuse := httptest.NewRecorder()
	h.ServeHTTP(reuse, loginRequest(`{"identifier":"admin","password":"admin"}`))
	assertProblem(t, reuse, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if !strings.Contains(reuse.Body.String(), invalidCredentialsDetail) {
		t.Fatalf("one-time reuse must be the same 401: %s", reuse.Body.String())
	}
	assertNoPasswordField(t, reuse.Body.String())
	for _, c := range reuse.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("dead one-time must not mint ff_session")
		}
	}

	next := httptest.NewRecorder()
	h.ServeHTTP(next, loginRequest(`{"identifier":"admin","password":"`+rotated+`"}`))
	if next.Code != http.StatusCreated {
		t.Fatalf("rotated login: %d %s", next.Code, next.Body.String())
	}
	var rotatedPayload sessionResponse
	if err := json.Unmarshal(next.Body.Bytes(), &rotatedPayload); err != nil {
		t.Fatal(err)
	}
	if rotatedPayload.Session.MustChangePassword {
		t.Fatal("rotated password must not require another change")
	}
}

func TestChangePasswordRejectsOneTimeAndReuse(t *testing.T) {
	store, h := newLoginEnv(t)
	seedMustChangeAdmin(t, store)
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+adminResetPassword+`"}`))
	token, csrf := sessionPair(t, login)

	oneTime := httptest.NewRecorder()
	h.ServeHTTP(oneTime, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"new_password":"admin"}`, token, csrf))
	assertProblem(t, oneTime, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if !strings.Contains(oneTime.Body.String(), changePasswordReuseDetail) {
		t.Fatalf("new==admin detail: %s", oneTime.Body.String())
	}
	assertNoPasswordField(t, oneTime.Body.String())

	reuse := httptest.NewRecorder()
	h.ServeHTTP(reuse, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"`+adminResetPassword+`"}`, token, csrf))
	assertProblem(t, reuse, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")

	short := httptest.NewRecorder()
	h.ServeHTTP(short, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"short"}`, token, csrf))
	assertProblem(t, short, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if strings.Contains(short.Body.String(), "short") {
		t.Fatal("400 must not echo the rejected password")
	}

	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !cred.MustChangePassword || !localauth.Verify(adminResetPassword, cred.PasswordHash) {
		t.Fatal("rejected change must leave the must-change hash in place")
	}
}

func TestChangePasswordRequiresCSRF(t *testing.T) {
	store, h := newLoginEnv(t)
	seedMustChangeAdmin(t, store)
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+adminResetPassword+`"}`))
	token, _ := sessionPair(t, login)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"correct-horse"}`, token, ""))
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
}

func TestChangePasswordRejectsEmbedSession(t *testing.T) {
	env := newEmbedEnv(t)
	rec := env.mint(t, `{"capabilities":["workflow.view"]}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("mint: %d %s", rec.Code, rec.Body.String())
	}
	var minted struct {
		Assertion string `json:"assertion"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &minted); err != nil {
		t.Fatal(err)
	}
	ex := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{"assertion":`+mustQuoteJSON(t, minted.Assertion)+`,"sdk":"embed.v1"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	env.h.ServeHTTP(ex, req)
	if ex.Code != http.StatusCreated {
		t.Fatalf("exchange: %d %s", ex.Code, ex.Body.String())
	}
	assertNoPasswordField(t, ex.Body.String())
	var exchanged sessionResponse
	if err := json.Unmarshal(ex.Body.Bytes(), &exchanged); err != nil {
		t.Fatal(err)
	}
	if exchanged.Session.Embed == nil {
		t.Fatal("exchange must stay embed-bound")
	}
	if exchanged.Session.MustChangePassword {
		t.Fatal("embed exchange must not set must_change_password")
	}

	token, csrf := sessionPair(t, ex)
	change := httptest.NewRecorder()
	env.h.ServeHTTP(change, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"correct-horse"}`, token, csrf))
	assertProblem(t, change, http.StatusForbidden, CodeForbidden, "caller-request-16")
}

func TestEnsureBootstrapLoginDoesNotOverwriteHTTP(t *testing.T) {
	store, h := newLoginEnv(t)
	user := seedLocalLogin(t, store, "https://idp.example", "ops@example.com", "Ops", "correct-horse")
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := store.LookupLocalLogin(t.Context(), "admin"); err == nil {
		t.Fatal("seed must not invent admin when a local login exists")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"ops@example.com","password":"correct-horse"}`))
	if rec.Code != http.StatusCreated {
		t.Fatalf("existing login: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("operator-set password must not force change")
	}
	if payload.Principal.ID != user.ID {
		t.Fatalf("principal %+v", payload.Principal)
	}
}

func TestTrustedDevSessionOmitsMustChangeClaim(t *testing.T) {
	store := identity.NewMemory()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(withHTTPTestIdentity(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{TrustIdentityHeaders: true},
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionCreateRequest("https://idp.example", "admin-1", "Operator"))
	if rec.Code != http.StatusCreated {
		t.Fatalf("trusted-dev session: %d %s", rec.Code, rec.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("trusted-dev POST /session must not carry the local one-time claim")
	}
	if payload.Principal.ExternalSubject != "admin-1" {
		t.Fatalf("trusted-dev principal %+v", payload.Principal)
	}
}

func sessionWorkspaceRequest(method, path, token, csrf string, tenant identity.Tenant, ws identity.Workspace) *http.Request {
	req := sessionAPIRequest(method, path, "", token, csrf)
	req.Header.Set(headerTenantID, tenant.ID)
	req.Header.Set(headerTenantSlug, tenant.Slug)
	req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	return req
}

func TestMustChangePasswordBlocksAuthenticatedAPI(t *testing.T) {
	store := identity.NewMemory()
	seedMustChangeAdmin(t, store)
	h := NewWithDeps(Deps{
		Store:     store,
		Sessions:  session.NewMemory(),
		Workflows: wfstore.NewMemory(),
		Quota:     quota.Unlimited(),
	})
	tenant, ws := bootstrapWorkspace(t, store)

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+adminResetPassword+`"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)

	blocked := httptest.NewRecorder()
	h.ServeHTTP(blocked, sessionWorkspaceRequest(http.MethodGet, "/api/v1/workflows", token, csrf, tenant, ws))
	assertProblem(t, blocked, http.StatusForbidden, CodePasswordChangeRequired, "caller-request-16")
	if !strings.Contains(blocked.Body.String(), passwordChangeRequiredDetail) {
		t.Fatalf("detail: %s", blocked.Body.String())
	}
	assertNoPasswordField(t, blocked.Body.String())

	anon := httptest.NewRecorder()
	anonReq := httptest.NewRequest(http.MethodGet, "/api/v1/workflows", nil)
	anonReq.Header.Set(headerTenantID, tenant.ID)
	anonReq.Header.Set(headerTenantSlug, tenant.Slug)
	anonReq.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	anonReq.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(anon, anonReq)
	assertProblem(t, anon, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	refresh := httptest.NewRecorder()
	h.ServeHTTP(refresh, sessionAPIRequest(http.MethodPost, "/api/v1/session/refresh", "", token, csrf))
	assertProblem(t, refresh, http.StatusForbidden, CodePasswordChangeRequired, "caller-request-16")

	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session: %d %s", get.Code, get.Body.String())
	}
	var current sessionResponse
	if err := json.Unmarshal(get.Body.Bytes(), &current); err != nil {
		t.Fatal(err)
	}
	if !current.Session.MustChangePassword {
		t.Fatal("GET /session must stay open and keep must_change_password")
	}

	logout := httptest.NewRecorder()
	h.ServeHTTP(logout, sessionAPIRequest(http.MethodPost, "/api/v1/session/logout", "", token, csrf))
	if logout.Code != http.StatusNoContent {
		t.Fatalf("logout: %d %s", logout.Code, logout.Body.String())
	}
	afterLogout := httptest.NewRecorder()
	h.ServeHTTP(afterLogout, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	assertProblem(t, afterLogout, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	login = httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+adminResetPassword+`"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("relogin: %d %s", login.Code, login.Body.String())
	}
	token, csrf = sessionPair(t, login)
	blocked = httptest.NewRecorder()
	h.ServeHTTP(blocked, sessionWorkspaceRequest(http.MethodGet, "/api/v1/workflows", token, csrf, tenant, ws))
	assertProblem(t, blocked, http.StatusForbidden, CodePasswordChangeRequired, "caller-request-16")

	change := httptest.NewRecorder()
	h.ServeHTTP(change, sessionAPIRequest(http.MethodPost, "/api/v1/session/password", `{"password":"correct-horse"}`, token, csrf))
	if change.Code != http.StatusOK {
		t.Fatalf("change-password: %d %s", change.Code, change.Body.String())
	}
	assertNoPasswordField(t, change.Body.String())

	opened := httptest.NewRecorder()
	h.ServeHTTP(opened, sessionWorkspaceRequest(http.MethodGet, "/api/v1/workflows", token, csrf, tenant, ws))
	if opened.Code != http.StatusOK {
		t.Fatalf("workflows after change: %d %s", opened.Code, opened.Body.String())
	}
	if strings.Contains(opened.Body.String(), "password_change_required") {
		t.Fatalf("cleared flag must not keep gating: %s", opened.Body.String())
	}
}

func TestMustChangePasswordDoesNotBlockIncompleteWizard(t *testing.T) {
	store := identity.NewMemory()
	seedMustChangeAdmin(t, store)
	h := NewWithDeps(Deps{
		Store:     store,
		Sessions:  session.NewMemory(),
		Bootstrap: bootstrap.NewMemory(),
		DB:        readyPersistenceDB(),
		Workflows: wfstore.NewMemory(),
		Quota:     quota.Unlimited(),
	})

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+adminResetPassword+`"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)

	wizard := httptest.NewRecorder()
	h.ServeHTTP(wizard, sessionAPIRequest(http.MethodPost, "/api/v1/bootstrap/persistence", `{"confirm":true}`, token, csrf))
	if wizard.Code != http.StatusOK {
		t.Fatalf("incomplete wizard: %d %s", wizard.Code, wizard.Body.String())
	}
	if strings.Contains(wizard.Body.String(), CodePasswordChangeRequired) {
		t.Fatalf("wizard must not require a password change: %s", wizard.Body.String())
	}
	assertNoPasswordField(t, wizard.Body.String())
	status := decodeBootstrapStatus(t, wizard)
	if status.Complete || !status.Incomplete || !status.Steps.Persistence.Ready {
		t.Fatalf("wizard step must succeed while incomplete: %+v", status)
	}

	product := httptest.NewRecorder()
	h.ServeHTTP(product, sessionAPIRequest(http.MethodGet, "/api/v1/workflows", "", token, csrf))
	assertProblem(t, product, http.StatusForbidden, CodePasswordChangeRequired, "caller-request-16")
}

func TestPasswordChangeGateAppliesToTrustedDevOfLocalLogin(t *testing.T) {
	store := identity.NewMemory()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), localauth.OneTimeIdentifier)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RequireLocalPasswordChange(t.Context(), cred.User.ID); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{TrustIdentityHeaders: true},
	})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/permission-matrix", nil)
	req.Header.Set(headerIssuer, localseed.BootstrapIssuer)
	req.Header.Set(headerSubject, localseed.BootstrapSubject)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusForbidden, CodePasswordChangeRequired, "caller-request-16")
}

func TestPasswordChangeGateSkipsPrincipalsWithoutLocalLogin(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(Deps{Store: store, Sessions: sessions})
	_, issued := issueTestSession(t, store, sessions, "https://idp.example", "machine-1", "Machine")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodGet, "/api/v1/permission-matrix", "", issued.Token, issued.CSRF))
	if rec.Code != http.StatusOK {
		t.Fatalf("principal without local login: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), CodePasswordChangeRequired) {
		t.Fatalf("machine/platform principal was gated: %s", rec.Body.String())
	}
}

func TestPasswordChangeGateSkipsEmbedSession(t *testing.T) {
	store := identity.NewMemory()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	sessions := session.NewMemory()
	h := NewWithDeps(Deps{Store: store, Sessions: sessions, Quota: quota.Unlimited()})
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RequireLocalPasswordChange(t.Context(), cred.User.ID); err != nil {
		t.Fatal(err)
	}
	cred, err = store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if !cred.MustChangePassword {
		t.Fatal("admin-initiated reset must still require a password change")
	}
	tenant, ws := bootstrapWorkspace(t, store)
	issued, err := sessions.Create(t.Context(), cred.User.ID, time.Now().UTC(), 30*time.Minute, 12*time.Hour, session.CreateOpts{
		AuthMethod: session.AuthMethodEmbed,
		Binding: session.Binding{
			TenantID:     tenant.ID,
			WorkbenchKey: ws.WorkbenchKey,
			WorkspaceID:  ws.ID,
			Capabilities: []string{"workflow.view"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodGet, "/api/v1/permission-matrix", "", issued.Token, issued.CSRF))
	if rec.Code != http.StatusOK {
		t.Fatalf("embed session: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), CodePasswordChangeRequired) {
		t.Fatalf("embed session was gated: %s", rec.Body.String())
	}
}

type lookupByUserErrorStore struct {
	*identity.Memory
	err error
}

func (s lookupByUserErrorStore) LookupLocalLoginByUser(context.Context, string) (identity.LocalLogin, error) {
	return identity.LocalLogin{}, s.err
}

func TestPasswordChangeGateFailsClosedOnLookupError(t *testing.T) {
	base := identity.NewMemory()
	if err := localseed.EnsureBootstrapLogin(t.Context(), base, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := base.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	hash, err := localauth.HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	if err := base.SetLocalPassword(t.Context(), cred.User.ID, cred.Identifier, hash); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(Deps{
		Store:    lookupByUserErrorStore{Memory: base, err: errors.New("db down")},
		Sessions: session.NewMemory(),
	})
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"correct-horse"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodGet, "/api/v1/permission-matrix", "", token, csrf))
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
	if strings.Contains(rec.Body.String(), "db down") {
		t.Fatal("store error must not leak to the client")
	}

	get := httptest.NewRecorder()
	h.ServeHTTP(get, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", token, csrf))
	if get.Code != http.StatusOK {
		t.Fatalf("GET /session stays available: %d %s", get.Code, get.Body.String())
	}
}

func bootstrapWorkspace(t *testing.T, store identity.Store) (identity.Tenant, identity.Workspace) {
	t.Helper()
	tenant, err := store.GetTenantBySlug(t.Context(), localseed.TenantSlug)
	if err != nil {
		t.Fatal(err)
	}
	ws, _, err := store.ResolveWorkspace(t.Context(), tenant.ID, localseed.TenantSlug, localseed.WorkbenchKey)
	if err != nil {
		t.Fatal(err)
	}
	return tenant, ws
}
