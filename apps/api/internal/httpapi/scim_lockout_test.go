package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/lockout"
	"github.com/bbengt1/flowforge/apps/api/internal/oidc"
	"github.com/bbengt1/flowforge/apps/api/internal/scim"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

const (
	scimTestToken = "scim-test-bearer-token-value-32b"
	scimWrongTok  = "not-the-scim-bearer-token-value!!"
	scimIssuer    = "https://idp.example"
)

func scimDeps(store identity.Store, sessions session.Store) Deps {
	return Deps{
		Store:    store,
		Sessions: sessions,
		Security: Security{TrustIdentityHeaders: true},
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  scimIssuer,
			Subject: "admin-1",
		}},
		SCIM: scim.Settings{
			BearerToken: scimTestToken,
			Issuer:      scimIssuer,
			DefaultRole: authz.RoleViewer,
		},
	}
}

func scimRequest(method, path, body, token string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/scim+json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func TestSCIMFailClosedMisconfig(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{Store: store, Sessions: session.NewMemory()})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, scimRequest(http.MethodGet, "/scim/v2/ServiceProviderConfig", "", scimTestToken))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), scimTestToken) {
		t.Fatal("misconfig response echoed the bearer")
	}

	h = NewWithDeps(scimDeps(store, session.NewMemory()))
	missing := httptest.NewRecorder()
	h.ServeHTTP(missing, scimRequest(http.MethodGet, "/scim/v2/Users", "", ""))
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("missing bearer: %d %s", missing.Code, missing.Body.String())
	}
	wrong := httptest.NewRecorder()
	h.ServeHTTP(wrong, scimRequest(http.MethodGet, "/scim/v2/Users", "", scimWrongTok))
	if wrong.Code != http.StatusUnauthorized || strings.Contains(wrong.Body.String(), scimWrongTok) || strings.Contains(wrong.Body.String(), scimTestToken) {
		t.Fatalf("wrong bearer: %d %s", wrong.Code, wrong.Body.String())
	}
	query := httptest.NewRecorder()
	h.ServeHTTP(query, scimRequest(http.MethodGet, "/scim/v2/Users?access_token="+scimTestToken, "", ""))
	if query.Code != http.StatusUnauthorized || strings.Contains(query.Body.String(), scimTestToken) {
		t.Fatalf("query token: %d %s", query.Code, query.Body.String())
	}

	secretBody := `{"userName":"ada@example.com","password":"super-secret-pass"}`
	rejected := httptest.NewRecorder()
	h.ServeHTTP(rejected, scimRequest(http.MethodPost, "/scim/v2/Users", secretBody, scimTestToken))
	if rejected.Code != http.StatusBadRequest || strings.Contains(rejected.Body.String(), "super-secret-pass") {
		t.Fatalf("secret echo: %d %s", rejected.Code, rejected.Body.String())
	}
}

func TestSCIMProvisionDeprovisionAndGroups(t *testing.T) {
	store := identity.NewMemory()
	sessions := session.NewMemory()
	h := NewWithDeps(scimDeps(store, sessions))
	admin := seedLocalLogin(t, store, scimIssuer, "admin-1", "Admin", "correct-horse")
	tenant, err := store.CreateTenant(t.Context(), "acme", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(t.Context(), tenant.ID, "default", "Default", admin.ID)
	if err != nil {
		t.Fatal(err)
	}

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)
	cookieOnly := httptest.NewRecorder()
	h.ServeHTTP(cookieOnly, sessionAPIRequest(http.MethodGet, "/scim/v2/Users", "", token, csrf))
	if cookieOnly.Code != http.StatusUnauthorized {
		t.Fatalf("session cookie must not authorize SCIM: %d %s", cookieOnly.Code, cookieOnly.Body.String())
	}
	sessionBearer := httptest.NewRecorder()
	asBearer := scimRequest(http.MethodGet, "/scim/v2/ServiceProviderConfig", "", token)
	h.ServeHTTP(sessionBearer, asBearer)
	if sessionBearer.Code != http.StatusUnauthorized || strings.Contains(sessionBearer.Body.String(), token) {
		t.Fatalf("ff_session bearer must not authorize SCIM: %d %s", sessionBearer.Code, sessionBearer.Body.String())
	}

	created := httptest.NewRecorder()
	body := `{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"Ada@Example.com","externalId":"ada-subject","displayName":"Ada Lovelace","active":true}`
	h.ServeHTTP(created, scimRequest(http.MethodPost, "/scim/v2/Users", body, scimTestToken))
	if created.Code != http.StatusCreated {
		t.Fatalf("provision: %d %s", created.Code, created.Body.String())
	}
	if strings.Contains(created.Body.String(), scimTestToken) || strings.Contains(created.Body.String(), "password") {
		t.Fatal("provision response echoed a secret")
	}
	var userRes struct {
		ID         string `json:"id"`
		UserName   string `json:"userName"`
		ExternalID string `json:"externalId"`
		Active     bool   `json:"active"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &userRes); err != nil {
		t.Fatal(err)
	}
	if !userRes.Active || userRes.ExternalID != "ada-subject" || userRes.UserName != "Ada@Example.com" {
		t.Fatalf("user: %+v", userRes)
	}
	stored, err := store.FindUser(t.Context(), scimIssuer, "ada-subject")
	if err != nil || stored.ID != userRes.ID || stored.Status != "active" {
		t.Fatalf("identity mapping: %+v %v", stored, err)
	}
	hash, err := localauth.HashPassword("correct-horse")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), stored.ID, "ada@example.com", hash); err != nil {
		t.Fatal(err)
	}
	adaLogin := httptest.NewRecorder()
	h.ServeHTTP(adaLogin, loginRequest(`{"identifier":"ada@example.com","password":"correct-horse"}`))
	if adaLogin.Code != http.StatusCreated {
		t.Fatalf("provisioned login: %d %s", adaLogin.Code, adaLogin.Body.String())
	}
	if strings.Contains(adaLogin.Body.String(), hash) || strings.Contains(adaLogin.Body.String(), "correct-horse") {
		t.Fatal("login echoed a secret")
	}
	adaToken, adaCSRF := sessionPair(t, adaLogin)

	filtered := httptest.NewRecorder()
	h.ServeHTTP(filtered, scimRequest(http.MethodGet, `/scim/v2/Users?filter=userName%20eq%20%22ada@example.com%22`, "", scimTestToken))
	if filtered.Code != http.StatusOK || !strings.Contains(filtered.Body.String(), userRes.ID) || strings.Contains(filtered.Body.String(), hash) {
		t.Fatalf("filter: %d %s", filtered.Code, filtered.Body.String())
	}

	groups := httptest.NewRecorder()
	h.ServeHTTP(groups, scimRequest(http.MethodGet, `/scim/v2/Groups?filter=displayName%20eq%20%22Default%22`, "", scimTestToken))
	if groups.Code != http.StatusOK || !strings.Contains(groups.Body.String(), ws.ID) {
		t.Fatalf("groups: %d %s", groups.Code, groups.Body.String())
	}
	add := `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"add","path":"members","value":[{"value":"` + userRes.ID + `"}]}]}`
	added := httptest.NewRecorder()
	h.ServeHTTP(added, scimRequest(http.MethodPatch, "/scim/v2/Groups/"+ws.ID, add, scimTestToken))
	if added.Code != http.StatusOK || !strings.Contains(added.Body.String(), userRes.ID) || strings.Contains(added.Body.String(), hash) {
		t.Fatalf("add member: %d %s", added.Code, added.Body.String())
	}
	roles, perms, err := store.EffectiveAccess(t.Context(), ws.ID, userRes.ID)
	if err != nil || !authz.Allows(perms, authz.PermWorkflowView) || authz.Allows(perms, authz.PermPlatformAdminister) {
		t.Fatalf("membership roles=%v perms=%v err=%v", roles, perms, err)
	}
	removeAdmin := `{"Operations":[{"op":"remove","path":"members[value eq \"` + admin.ID + `\"]"}]}`
	kept := httptest.NewRecorder()
	h.ServeHTTP(kept, scimRequest(http.MethodPatch, "/scim/v2/Groups/"+ws.ID, removeAdmin, scimTestToken))
	if kept.Code != http.StatusConflict {
		t.Fatalf("last admin: %d %s", kept.Code, kept.Body.String())
	}

	inactive := `{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`
	patched := httptest.NewRecorder()
	h.ServeHTTP(patched, scimRequest(http.MethodPatch, "/scim/v2/Users/"+userRes.ID, inactive, scimTestToken))
	if patched.Code != http.StatusOK || strings.Contains(patched.Body.String(), `"active":true`) {
		t.Fatalf("deactivate: %d %s", patched.Code, patched.Body.String())
	}
	blocked := httptest.NewRecorder()
	h.ServeHTTP(blocked, loginRequest(`{"identifier":"ada@example.com","password":"correct-horse"}`))
	if blocked.Code != http.StatusUnauthorized || strings.Contains(blocked.Body.String(), "correct-horse") || strings.Contains(blocked.Body.String(), hash) {
		t.Fatalf("deactivated login: %d %s", blocked.Code, blocked.Body.String())
	}
	stale := httptest.NewRecorder()
	h.ServeHTTP(stale, sessionAPIRequest(http.MethodGet, "/api/v1/session", "", adaToken, adaCSRF))
	if stale.Code != http.StatusForbidden && stale.Code != http.StatusUnauthorized {
		t.Fatalf("revoked session: %d %s", stale.Code, stale.Body.String())
	}

	deleted := httptest.NewRecorder()
	h.ServeHTTP(deleted, scimRequest(http.MethodDelete, "/scim/v2/Users/"+userRes.ID, "", scimTestToken))
	if deleted.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body.String())
	}
	gone := httptest.NewRecorder()
	h.ServeHTTP(gone, scimRequest(http.MethodGet, "/scim/v2/Users/"+userRes.ID, "", scimTestToken))
	if gone.Code != http.StatusNotFound || strings.Contains(gone.Body.String(), hash) {
		t.Fatalf("deprovisioned get: %d %s", gone.Code, gone.Body.String())
	}

	machine := httptest.NewRecorder()
	mreq := httptest.NewRequest(http.MethodPost, "/api/v1/machine/token", strings.NewReader(`{}`))
	mreq.Header.Set("Content-Type", "application/json")
	mreq.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(machine, mreq)
	if machine.Code == http.StatusCreated || machine.Code == http.StatusNotFound {
		t.Fatalf("machine door changed: %d %s", machine.Code, machine.Body.String())
	}
	embed := httptest.NewRecorder()
	ereq := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{}`))
	ereq.Header.Set("Content-Type", "application/json")
	ereq.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(embed, ereq)
	if embed.Code == http.StatusCreated || embed.Code == http.StatusNotFound {
		t.Fatalf("embed door changed: %d %s", embed.Code, embed.Body.String())
	}
	still := httptest.NewRecorder()
	h.ServeHTTP(still, loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`))
	if still.Code != http.StatusCreated {
		t.Fatalf("local login door changed: %d %s", still.Code, still.Body.String())
	}
}

func TestDurableLockoutSurvivesRestart(t *testing.T) {
	store := identity.NewMemory()
	locks := lockout.NewMemory()
	deps := func(sessions session.Store) Deps {
		d := scimDeps(store, sessions)
		d.Lockouts = locks
		d.LockoutMaxFailures = 2
		return d
	}
	h := NewWithDeps(deps(session.NewMemory()))
	victim := seedLocalLogin(t, store, scimIssuer, "operator", "Operator", "correct-horse")
	hash := mustLocalHash(t, store, victim.ID)

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, loginRequest(`{"identifier":"operator","password":"wrong-password"}`))
		if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "wrong-password") || strings.Contains(rec.Body.String(), hash) {
			t.Fatalf("failure %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	locked := httptest.NewRecorder()
	h.ServeHTTP(locked, loginRequest(`{"identifier":"operator","password":"correct-horse"}`))
	if locked.Code != http.StatusUnauthorized || strings.Contains(locked.Body.String(), "correct-horse") {
		t.Fatalf("locked: %d %s", locked.Code, locked.Body.String())
	}

	restarted := NewWithDeps(deps(session.NewMemory()))
	again := httptest.NewRecorder()
	restarted.ServeHTTP(again, loginRequest(`{"identifier":"operator","password":"correct-horse"}`))
	if again.Code != http.StatusUnauthorized || strings.Contains(again.Body.String(), "correct-horse") {
		t.Fatalf("restart kept the door open: %d %s", again.Code, again.Body.String())
	}

	adminLogin := httptest.NewRecorder()
	restarted.ServeHTTP(adminLogin, sessionCreateRequest(scimIssuer, "admin-1", "Admin"))
	if adminLogin.Code != http.StatusCreated {
		t.Fatalf("admin session: %d %s", adminLogin.Code, adminLogin.Body.String())
	}
	token, csrf := sessionPair(t, adminLogin)
	view := httptest.NewRecorder()
	restarted.ServeHTTP(view, sessionAPIRequest(http.MethodGet, "/api/v1/users/"+victim.ID+"/lockout", "", token, csrf))
	if view.Code != http.StatusOK || !strings.Contains(view.Body.String(), `"locked":true`) || strings.Contains(view.Body.String(), hash) || strings.Contains(view.Body.String(), "correct-horse") {
		t.Fatalf("lockout view: %d %s", view.Code, view.Body.String())
	}
	outsider := seedLocalLogin(t, store, scimIssuer, "outsider", "Outsider", "correct-horse")
	outLogin := httptest.NewRecorder()
	restarted.ServeHTTP(outLogin, loginRequest(`{"identifier":"outsider","password":"correct-horse"}`))
	if outLogin.Code != http.StatusCreated {
		t.Fatalf("outsider login: %d %s", outLogin.Code, outLogin.Body.String())
	}
	outToken, outCSRF := sessionPair(t, outLogin)
	denied := httptest.NewRecorder()
	restarted.ServeHTTP(denied, sessionAPIRequest(http.MethodPost, "/api/v1/users/"+victim.ID+"/unlock", "", outToken, outCSRF))
	if denied.Code != http.StatusForbidden {
		t.Fatalf("non-admin unlock: %d %s", denied.Code, denied.Body.String())
	}
	_ = outsider

	unlocked := httptest.NewRecorder()
	restarted.ServeHTTP(unlocked, sessionAPIRequest(http.MethodPost, "/api/v1/users/"+victim.ID+"/unlock", "", token, csrf))
	if unlocked.Code != http.StatusOK || strings.Contains(unlocked.Body.String(), `"locked":true`) || strings.Contains(unlocked.Body.String(), hash) {
		t.Fatalf("unlock: %d %s", unlocked.Code, unlocked.Body.String())
	}
	ok := httptest.NewRecorder()
	restarted.ServeHTTP(ok, loginRequest(`{"identifier":"operator","password":"correct-horse"}`))
	if ok.Code != http.StatusCreated || strings.Contains(ok.Body.String(), hash) {
		t.Fatalf("unlocked login: %d %s", ok.Code, ok.Body.String())
	}
}

func TestOIDCSignInHonorsDurableLock(t *testing.T) {
	idp := newHTTPFakeIDP(t)
	defer idp.close()
	store := identity.NewMemory()
	locks := lockout.NewMemory()
	secretKey := []byte("0123456789abcdef0123456789abcdef")
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Lockouts: locks,
		OIDC: oidc.Settings{
			Issuer:       idp.url,
			ClientID:     "flowforge",
			ClientSecret: idp.secret,
			RedirectURI:  "https://app.example/callback",
			Scopes:       "openid profile email",
			StateKey:     secretKey,
		},
	})
	startAndCallback := func() *httptest.ResponseRecorder {
		t.Helper()
		start := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/oidc/start", strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set(RequestIDHeader, "caller-request-16")
		h.ServeHTTP(start, req)
		if start.Code != http.StatusOK {
			t.Fatalf("oidc start: %d %s", start.Code, start.Body.String())
		}
		var started struct {
			AuthorizationURL string `json:"authorization_url"`
			State            string `json:"state"`
		}
		if err := json.Unmarshal(start.Body.Bytes(), &started); err != nil {
			t.Fatal(err)
		}
		authURL := mustParseURL(t, started.AuthorizationURL)
		idp.setNonce(authURL.Query().Get("nonce"))
		cb := httptest.NewRequest(http.MethodPost, "/api/v1/oidc/callback", strings.NewReader(`{"code":"good-code","state":"`+started.State+`"}`))
		cb.Header.Set("Content-Type", "application/json")
		cb.Header.Set(RequestIDHeader, "caller-request-16")
		for _, c := range start.Result().Cookies() {
			if c.Name == oidc.StateCookie {
				cb.AddCookie(c)
			}
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, cb)
		return rec
	}
	first := startAndCallback()
	if first.Code != http.StatusCreated || strings.Contains(first.Body.String(), idp.secret) {
		t.Fatalf("oidc login: %d %s", first.Code, first.Body.String())
	}
	var sessionBody sessionResponse
	if err := json.Unmarshal(first.Body.Bytes(), &sessionBody); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := locks.NoteFailure(t.Context(), sessionBody.Principal.ID, 1, now); err != nil {
		t.Fatal(err)
	}
	second := startAndCallback()
	if second.Code != http.StatusUnauthorized || strings.Contains(second.Body.String(), idp.secret) {
		t.Fatalf("locked oidc: %d %s", second.Code, second.Body.String())
	}
	if err := locks.Unlock(t.Context(), sessionBody.Principal.ID); err != nil {
		t.Fatal(err)
	}
	third := startAndCallback()
	if third.Code != http.StatusCreated || strings.Contains(third.Body.String(), idp.secret) {
		t.Fatalf("unlocked oidc: %d %s", third.Code, third.Body.String())
	}
}

func TestLockoutStoreFailureFailsClosed(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Store:              store,
		Sessions:           session.NewMemory(),
		Lockouts:           downLockout{},
		LockoutMaxFailures: 5,
	})
	seedLocalLogin(t, store, scimIssuer, "operator", "Operator", "correct-horse")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"operator","password":"correct-horse"}`))
	if rec.Code != http.StatusServiceUnavailable || strings.Contains(rec.Body.String(), "correct-horse") {
		t.Fatalf("store down: %d %s", rec.Code, rec.Body.String())
	}
}

type downLockout struct{}

func (downLockout) NoteFailure(context.Context, string, int, time.Time) (lockout.State, error) {
	return lockout.State{}, lockout.ErrUnavailable
}

func (downLockout) Get(context.Context, string) (lockout.State, error) {
	return lockout.State{}, lockout.ErrUnavailable
}

func (downLockout) Clear(context.Context, string) error { return lockout.ErrUnavailable }

func (downLockout) Unlock(context.Context, string) error { return lockout.ErrUnavailable }

func mustLocalHash(t *testing.T, store *identity.Memory, userID string) string {
	t.Helper()
	cred, err := store.LookupLocalLoginByUser(t.Context(), userID)
	if err != nil {
		t.Fatal(err)
	}
	if cred.PasswordHash == "" {
		t.Fatal("missing hash")
	}
	return cred.PasswordHash
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
