package httpapi

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/bootstrap"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/localauth"
	"github.com/bbengt1/flowforge/apps/api/internal/localseed"
	"github.com/bbengt1/flowforge/apps/api/internal/observability"
	"github.com/bbengt1/flowforge/apps/api/internal/quota"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
	"github.com/bbengt1/flowforge/apps/api/internal/wfstore"
)

const (
	setupTokenValue = "setup-token-value1"
	setupPassword   = "correct-horse"
)

type adminPasswordBody struct {
	AdminPasswordSet   bool             `json:"adminPasswordSet"`
	MustChangePassword bool             `json:"mustChangePassword"`
	LoginReady         bool             `json:"loginReady"`
	Identifier         string           `json:"identifier"`
	Bootstrap          bootstrap.Status `json:"bootstrap"`
}

func newSetupEnv(t *testing.T, limit int) (*identity.Memory, *bootstrap.Memory, *session.Memory, *bytes.Buffer, http.Handler) {
	t.Helper()
	store := identity.NewMemory()
	boot := bootstrap.NewMemory()
	sessions := session.NewMemory()
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	h := NewWithDeps(Deps{
		Store:        store,
		Bootstrap:    boot,
		Sessions:     sessions,
		Workflows:    wfstore.NewMemory(),
		Quota:        quota.Unlimited(),
		SetupIPLimit: limit,
		Log:          log,
	})
	return store, boot, sessions, &buf, h
}

func seedUnsetAdmin(t *testing.T, store *identity.Memory, boot *bootstrap.Memory, token string, log *slog.Logger) {
	t.Helper()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, log); err != nil {
		t.Fatal(err)
	}
	if err := localseed.PrepareAdminPassword(t.Context(), store, boot, log, token); err != nil {
		t.Fatal(err)
	}
}

func adminPasswordRequest(body string) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/bootstrap/admin-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	return req
}

func setupBody(token, password string) string {
	raw, err := json.Marshal(map[string]string{"setup_token": token, "password": password})
	if err != nil {
		panic(err)
	}
	return string(raw)
}

func assertNoSetupSecrets(t *testing.T, body, token, password string) {
	t.Helper()
	if token != "" && strings.Contains(body, token) {
		t.Fatal("response must not echo the setup token")
	}
	if password != "" && strings.Contains(body, password) {
		t.Fatal("response must not echo the password")
	}
	if strings.Contains(body, "$2a$") || strings.Contains(body, "$2b$") {
		t.Fatal("response must not include a bcrypt hash")
	}
	if strings.Contains(body, `"setup_token"`) || strings.Contains(body, `"password"`) {
		t.Fatalf("response must not include secret fields: %s", body)
	}
}

func assertNoSessionCookie(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == session.CookieName && c.Value != "" && c.MaxAge != -1 {
			t.Fatal("set-password must not mint ff_session")
		}
	}
}

func decodeAdminPassword(t *testing.T, rec *httptest.ResponseRecorder) adminPasswordBody {
	t.Helper()
	var body adminPasswordBody
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body
}

func TestAdminPasswordPath1CompleteWizardThenNormalLogin(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	seedUnsetAdmin(t, store, boot, setupTokenValue, log)
	if err := boot.MarkSeedSkip(t.Context(), bootstrap.SeedSkip{}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(buf.String(), setupTokenValue) {
		t.Fatal("environment token must not be printed")
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("path 1 set-password: %d %s", rec.Code, rec.Body.String())
	}
	assertNoSetupSecrets(t, rec.Body.String(), setupTokenValue, setupPassword)
	assertNoSessionCookie(t, rec)
	body := decodeAdminPassword(t, rec)
	if !body.AdminPasswordSet || body.MustChangePassword || !body.LoginReady || body.Identifier != "admin" {
		t.Fatalf("201 body: %+v", body)
	}
	if !body.Bootstrap.Complete || !body.Bootstrap.Skipped || body.Bootstrap.Incomplete {
		t.Fatalf("path 1 stays complete: %+v", body.Bootstrap)
	}

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+setupPassword+`"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(login.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("first-run set-password must not force another change")
	}
	token, csrf := sessionPair(t, login)
	tenant, ws := bootstrapWorkspace(t, store)
	opened := httptest.NewRecorder()
	h.ServeHTTP(opened, sessionWorkspaceRequest(http.MethodGet, "/api/v1/workflows", token, csrf, tenant, ws))
	if opened.Code != http.StatusOK {
		t.Fatalf("workflows: %d %s", opened.Code, opened.Body.String())
	}
}

func TestAdminPasswordPath2IncompleteWizard(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	if err := boot.SetStep(t.Context(), bootstrap.StepPersistence, true); err != nil {
		t.Fatal(err)
	}

	rejected := httptest.NewRecorder()
	h.ServeHTTP(rejected, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1","password":"super-secret-hunter2"}`))
	assertProblem(t, rejected, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if strings.Contains(rejected.Body.String(), "super-secret-hunter2") {
		t.Fatal("rejected B.3 must not echo a password")
	}

	created := httptest.NewRecorder()
	h.ServeHTTP(created, firstAdminRequest(`{"issuer":"https://idp.example","external_subject":"admin-1","display_name":"Operator"}`))
	if created.Code != http.StatusCreated {
		t.Fatalf("B.3 without password: %d %s", created.Code, created.Body.String())
	}
	status := decodeBootstrapStatus(t, created)
	if status.Complete || !status.Incomplete || !status.Steps.FirstAdmin.Ready {
		t.Fatalf("path 2 stays incomplete: %+v", status)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("path 2 set-password: %d %s", rec.Code, rec.Body.String())
	}
	body := decodeAdminPassword(t, rec)
	if body.MustChangePassword || !body.LoginReady || body.Bootstrap.Complete {
		t.Fatalf("path 2 201: %+v", body)
	}
	assertNoSetupSecrets(t, rec.Body.String(), setupTokenValue, setupPassword)

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin","password":"`+setupPassword+`"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("login: %d %s", login.Code, login.Body.String())
	}
	var payload sessionResponse
	if err := json.Unmarshal(login.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Session.MustChangePassword {
		t.Fatal("path 2 login must not require a password change")
	}
}

func TestRetiredAdminCredentialCannotLogIn(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginRequest(`{"identifier":"admin","password":"admin"}`))
	assertProblem(t, rec, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if !strings.Contains(rec.Body.String(), invalidCredentialsDetail) {
		t.Fatalf("retired pair: %s", rec.Body.String())
	}
	assertNoSessionCookie(t, rec)
	assertNoPasswordField(t, rec.Body.String())

	legacy, err := localauth.HashOneTimePassword()
	if err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), cred.User.ID, cred.Identifier, legacy); err != nil {
		t.Fatal(err)
	}
	planted := httptest.NewRecorder()
	h.ServeHTTP(planted, loginRequest(`{"identifier":"admin","password":"admin"}`))
	assertProblem(t, planted, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	assertNoSessionCookie(t, planted)
}

func TestAdminPasswordRaceOneSuccess(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	body := setupBody(setupTokenValue, setupPassword)

	var wg sync.WaitGroup
	codes := make([]int, 2)
	wg.Add(2)
	for i := 0; i < 2; i++ {
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, adminPasswordRequest(body))
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()
	sawCreated, sawConflict := false, false
	for _, code := range codes {
		switch code {
		case http.StatusCreated:
			sawCreated = true
		case http.StatusConflict:
			sawConflict = true
		default:
			t.Fatalf("race codes %v", codes)
		}
	}
	if !sawCreated || !sawConflict {
		t.Fatalf("race codes %v, want 201 and 409", codes)
	}

	again := httptest.NewRecorder()
	h.ServeHTTP(again, adminPasswordRequest(body))
	assertProblem(t, again, http.StatusConflict, CodeConflict, "caller-request-16")
	if !strings.Contains(again.Body.String(), "no longer valid") {
		t.Fatalf("conflict detail: %s", again.Body.String())
	}
}

func TestAdminPasswordRateLimit(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 1)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))

	first := httptest.NewRecorder()
	h.ServeHTTP(first, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	if first.Code != http.StatusCreated {
		t.Fatalf("first: %d %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	h.ServeHTTP(second, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	assertProblem(t, second, http.StatusTooManyRequests, CodeRateLimited, "caller-request-16")
	if second.Header().Get("Retry-After") == "" {
		t.Fatal("429 must set Retry-After")
	}
	if strings.Contains(second.Body.String(), setupTokenValue) || strings.Contains(second.Body.String(), setupPassword) {
		t.Fatal("429 must not echo secrets")
	}
}

func TestAdminPasswordFromEnvironmentToken(t *testing.T) {
	store, boot, sessions, _, h := newSetupEnv(t, 0)
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	seedUnsetAdmin(t, store, boot, setupTokenValue, log)
	if strings.Contains(buf.String(), setupTokenValue) {
		t.Fatal("FLOWFORGE_SETUP_TOKEN must not be logged")
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash != bootstrap.HashSetupToken(setupTokenValue) {
		t.Fatal("stored digest must match the environment token")
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("env token: %d %s", rec.Code, rec.Body.String())
	}
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	events, err := sessions.ListAudit(t.Context(), cred.User.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, event := range events {
		if event.EventType == session.EventBootstrapAdminPasswordSet && event.Outcome == session.OutcomeAllowed {
			found = true
			if strings.Contains(event.Reason, setupTokenValue) || strings.Contains(event.Reason, setupPassword) {
				t.Fatal("audit reason must not carry the token or password")
			}
		}
	}
	if !found {
		t.Fatalf("missing audit event: %+v", events)
	}
}

func TestGeneratedSetupTokenPrintsOnce(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	if err := localseed.PrepareAdminPassword(t.Context(), store, boot, log, ""); err != nil {
		t.Fatal(err)
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	token := setupValueFromLog(t, buf.String())
	if st.SetupTokenHash != bootstrap.HashSetupToken(token) {
		t.Fatal("printed token must match the stored digest")
	}
	if strings.Count(buf.String(), token) != 1 {
		t.Fatalf("token must be printed once: %s", buf.String())
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(token, setupPassword)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("generated token: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), token) {
		t.Fatal("201 must not echo the generated token")
	}
}

func TestUpgradeClearsRetiredDefaultHash(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := localauth.HashOneTimePassword()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetLocalPassword(t.Context(), cred.User.ID, cred.Identifier, legacy); err != nil {
		t.Fatal(err)
	}
	if err := store.RequireLocalPasswordChange(t.Context(), cred.User.ID); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	log := slog.New(observability.NewRedactingHandler(slog.NewJSONHandler(&buf, nil)))
	if err := localseed.PrepareAdminPassword(t.Context(), store, boot, log, setupTokenValue); err != nil {
		t.Fatal(err)
	}
	cleared, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	if cleared.PasswordHash != localauth.UnusablePasswordHash || cleared.MustChangePassword {
		t.Fatalf("upgrade must clear the retired hash: %+v", cleared)
	}
	if localauth.Verify(localauth.OneTimePassword, cleared.PasswordHash) {
		t.Fatal("retired password must not verify after upgrade")
	}
	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, loginRequest(`{"identifier":"admin","password":"admin"}`))
	assertProblem(t, denied, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	if rec.Code != http.StatusCreated {
		t.Fatalf("upgrade set-password: %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminPasswordRejectsWrongTokenThenAccepts(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))

	wrong := httptest.NewRecorder()
	h.ServeHTTP(wrong, adminPasswordRequest(setupBody("wrong-setup-token", setupPassword)))
	assertProblem(t, wrong, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if strings.Contains(wrong.Body.String(), setupTokenValue) || strings.Contains(wrong.Body.String(), "wrong-setup-token") {
		t.Fatal("401 must not echo tokens")
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash == "" {
		t.Fatal("a rejected token must not be consumed")
	}

	ok := httptest.NewRecorder()
	h.ServeHTTP(ok, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	if ok.Code != http.StatusCreated {
		t.Fatalf("matching token: %d %s", ok.Code, ok.Body.String())
	}
	consumed := httptest.NewRecorder()
	h.ServeHTTP(consumed, adminPasswordRequest(setupBody(setupTokenValue, "another-horse")))
	assertProblem(t, consumed, http.StatusConflict, CodeConflict, "caller-request-16")
}

func TestAdminPasswordValidationDoesNotConsumeToken(t *testing.T) {
	store, boot, _, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))

	cases := []string{
		`{"setup_token":"` + setupTokenValue + `","password":"short"}`,
		`{"setup_token":"` + setupTokenValue + `","password":"admin"}`,
		`{"setup_token":"` + setupTokenValue + `","password":"` + setupTokenValue + `"}`,
		`{"setup_token":"` + setupTokenValue + `","password":"` + setupPassword + `","note":"no"}`,
	}
	for _, body := range cases {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, adminPasswordRequest(body))
		assertProblem(t, rec, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
		if strings.Contains(rec.Body.String(), setupTokenValue) || strings.Contains(rec.Body.String(), setupPassword) {
			t.Fatalf("400 echoed a secret: %s", rec.Body.String())
		}
	}
	query := httptest.NewRecorder()
	req := adminPasswordRequest(setupBody(setupTokenValue, setupPassword))
	req.URL.RawQuery = "setup_token=" + setupTokenValue
	h.ServeHTTP(query, req)
	assertProblem(t, query, http.StatusBadRequest, CodeInvalidRequest, "caller-request-16")
	if strings.Contains(query.Body.String(), setupTokenValue) {
		t.Fatal("query rejection must not echo the token")
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash != bootstrap.HashSetupToken(setupTokenValue) {
		t.Fatal("validation failures must leave the digest in place")
	}

	ok := httptest.NewRecorder()
	h.ServeHTTP(ok, adminPasswordRequest(`{"setup-token":"`+setupTokenValue+`","password":"`+setupPassword+`"}`))
	if ok.Code != http.StatusCreated {
		t.Fatalf("hyphenated field: %d %s", ok.Code, ok.Body.String())
	}
}

func TestAdminPasswordRequiresCSRFWhenSessionPresent(t *testing.T) {
	store, boot, sessions, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	issued, err := sessions.Create(t.Context(), cred.User.ID, time.Now().UTC(), time.Minute, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodPost, "/api/v1/bootstrap/admin-password", setupBody(setupTokenValue, setupPassword), issued.Token, ""))
	assertProblem(t, rec, http.StatusForbidden, CodeCSRFInvalid, "caller-request-16")
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash == "" {
		t.Fatal("CSRF failure must not consume the token")
	}
}

func TestAdminPasswordRejectsEmbedSession(t *testing.T) {
	store, boot, sessions, _, h := newSetupEnv(t, 0)
	seedUnsetAdmin(t, store, boot, setupTokenValue, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	cred, err := store.LookupLocalLogin(t.Context(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	tenant, ws := bootstrapWorkspace(t, store)
	issued, err := sessions.Create(t.Context(), cred.User.ID, time.Now().UTC(), time.Minute, time.Hour, session.CreateOpts{
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
	h.ServeHTTP(rec, sessionAPIRequest(http.MethodPost, "/api/v1/bootstrap/admin-password", setupBody(setupTokenValue, setupPassword), issued.Token, issued.CSRF))
	assertProblem(t, rec, http.StatusForbidden, CodeForbidden, "caller-request-16")
	if !strings.Contains(rec.Body.String(), "standalone") {
		t.Fatalf("embed deny: %s", rec.Body.String())
	}
	st, err := boot.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash == "" {
		t.Fatal("embed deny must not consume the token")
	}
}

func TestAdminPasswordMissingAdminIsConflict(t *testing.T) {
	_, boot, _, _, h := newSetupEnv(t, 0)
	if err := boot.SetSetupTokenHash(t.Context(), bootstrap.HashSetupToken(setupTokenValue)); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	assertProblem(t, rec, http.StatusConflict, CodeConflict, "caller-request-16")
}

func TestAdminPasswordStoreDownIs503(t *testing.T) {
	store := identity.NewMemory()
	if err := localseed.EnsureBootstrapLogin(t.Context(), store, nil); err != nil {
		t.Fatal(err)
	}
	h := NewWithDeps(Deps{
		Store:     store,
		Bootstrap: &unavailableBootstrap{},
		Sessions:  session.NewMemory(),
	})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, adminPasswordRequest(setupBody(setupTokenValue, setupPassword)))
	assertProblem(t, rec, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
}

func TestBootstrapStatusOmitsSetupTokenHash(t *testing.T) {
	_, boot, _, _, h := newSetupEnv(t, 0)
	hash := bootstrap.HashSetupToken(setupTokenValue)
	if err := boot.SetSetupTokenHash(t.Context(), hash); err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/bootstrap", nil)
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET bootstrap: %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), hash) || strings.Contains(strings.ToLower(rec.Body.String()), "setup_token") {
		t.Fatalf("status leaked the digest: %s", rec.Body.String())
	}
}

func setupValueFromLog(t *testing.T, raw string) string {
	t.Helper()
	for _, line := range strings.Split(raw, "\n") {
		if !strings.Contains(line, `"setup"`) {
			continue
		}
		var row map[string]any
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			t.Fatal(err)
		}
		token, _ := row["setup"].(string)
		if token == "" {
			t.Fatalf("setup attribute missing: %s", line)
		}
		return token
	}
	t.Fatalf("generated token was not logged: %s", raw)
	return ""
}
