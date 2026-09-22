package httpapi

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
	"github.com/bbengt1/flowforge/apps/api/internal/identity"
	"github.com/bbengt1/flowforge/apps/api/internal/mfa"
	"github.com/bbengt1/flowforge/apps/api/internal/oidc"
	"github.com/bbengt1/flowforge/apps/api/internal/session"
)

func TestOIDCAndMFAAPIContract(t *testing.T) {
	idp := newHTTPFakeIDP(t)
	defer idp.close()
	store := identity.NewMemory()
	secretKey := []byte("0123456789abcdef0123456789abcdef")
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		Security: Security{TrustIdentityHeaders: true},
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  "https://idp.example",
			Subject: "admin-1",
		}},
		OIDC: oidc.Settings{
			Issuer:       idp.url,
			ClientID:     "flowforge",
			ClientSecret: idp.secret,
			RedirectURI:  "https://app.example/callback",
			Scopes:       "openid profile email",
			StateKey:     secretKey,
		},
		MFAKey: secretKey,
	})
	user := seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")
	tenant, err := store.CreateTenant(t.Context(), "acme", "Acme")
	if err != nil {
		t.Fatal(err)
	}
	ws, err := store.CreateWorkspace(t.Context(), tenant.ID, "default", "Default", user.ID)
	if err != nil {
		t.Fatal(err)
	}

	trusted := httptest.NewRecorder()
	h.ServeHTTP(trusted, sessionCreateRequest("https://idp.example", "admin-1", "Operator"))
	if trusted.Code != http.StatusCreated {
		t.Fatalf("trusted-dev session: %d %s", trusted.Code, trusted.Body.String())
	}
	tToken, tCSRF := sessionPair(t, trusted)
	openapi := httptest.NewRecorder()
	h.ServeHTTP(openapi, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", tToken, tCSRF))
	if openapi.Code != http.StatusOK {
		t.Fatalf("trusted-dev platform admin must stay ungated: %d %s", openapi.Code, openapi.Body.String())
	}

	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("local login: %d %s", login.Code, login.Body.String())
	}
	if strings.Contains(login.Body.String(), "correct-horse") {
		t.Fatal("local login echoed the password")
	}
	token, csrf := sessionPair(t, login)

	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", token, csrf))
	assertProblem(t, denied, http.StatusForbidden, CodeMFARequired, "caller-request-16")

	cred := credentialRequest(http.MethodGet, "/api/v1/credentials", token, csrf, tenant, ws)
	credRec := httptest.NewRecorder()
	h.ServeHTTP(credRec, cred)
	assertProblem(t, credRec, http.StatusForbidden, CodeMFARequired, "caller-request-16")

	enroll := httptest.NewRecorder()
	h.ServeHTTP(enroll, sessionAPIRequest(http.MethodPost, "/api/v1/session/mfa/enroll", "{}", token, csrf))
	if enroll.Code != http.StatusOK {
		t.Fatalf("enroll: %d %s", enroll.Code, enroll.Body.String())
	}
	var enrolled mfaStatus
	if err := json.Unmarshal(enroll.Body.Bytes(), &enrolled); err != nil {
		t.Fatal(err)
	}
	if enrolled.OTPAuthURI == "" || !strings.Contains(enrolled.OTPAuthURI, "otpauth://") {
		t.Fatalf("enroll uri: %+v", enrolled)
	}
	secret := totpSecret(t, enrolled.OTPAuthURI)
	status := httptest.NewRecorder()
	h.ServeHTTP(status, sessionAPIRequest(http.MethodGet, "/api/v1/session/mfa", "", token, csrf))
	if status.Code != http.StatusOK {
		t.Fatalf("mfa status: %d %s", status.Code, status.Body.String())
	}
	if strings.Contains(status.Body.String(), secret) || strings.Contains(status.Body.String(), "otpauth") {
		t.Fatal("MFA status echoed the TOTP secret")
	}

	bad := httptest.NewRecorder()
	h.ServeHTTP(bad, sessionAPIRequest(http.MethodPost, "/api/v1/session/mfa/verify", `{"code":"000000"}`, token, csrf))
	assertProblem(t, bad, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")
	if strings.Contains(bad.Body.String(), "000000") || strings.Contains(bad.Body.String(), secret) {
		t.Fatal("verify failure echoed secret material")
	}

	code := mfa.Code(mustDecodeTOTP(t, secret), time.Now().Unix()/30)
	ok := httptest.NewRecorder()
	h.ServeHTTP(ok, sessionAPIRequest(http.MethodPost, "/api/v1/session/mfa/verify", `{"code":"`+code+`"}`, token, csrf))
	if ok.Code != http.StatusOK {
		t.Fatalf("verify: %d %s", ok.Code, ok.Body.String())
	}
	if strings.Contains(ok.Body.String(), secret) || strings.Contains(ok.Body.String(), code) {
		t.Fatal("verify success echoed secret material")
	}
	again := httptest.NewRecorder()
	h.ServeHTTP(again, sessionAPIRequest(http.MethodPost, "/api/v1/session/mfa/enroll", "{}", token, csrf))
	assertProblem(t, again, http.StatusConflict, CodeConflict, "caller-request-16")
	if strings.Contains(again.Body.String(), secret) {
		t.Fatal("re-enroll echoed the secret")
	}

	allowed := httptest.NewRecorder()
	h.ServeHTTP(allowed, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", token, csrf))
	if allowed.Code != http.StatusOK {
		t.Fatalf("openapi after MFA: %d %s", allowed.Code, allowed.Body.String())
	}
	credOK := httptest.NewRecorder()
	h.ServeHTTP(credOK, credentialRequest(http.MethodGet, "/api/v1/credentials", token, csrf, tenant, ws))
	if credOK.Code != http.StatusOK {
		t.Fatalf("credentials after MFA: %d %s", credOK.Code, credOK.Body.String())
	}

	start := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oidc/start", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(start, req)
	if start.Code != http.StatusOK {
		t.Fatalf("oidc start: %d %s", start.Code, start.Body.String())
	}
	if strings.Contains(start.Body.String(), idp.secret) || strings.Contains(start.Body.String(), "code_verifier") {
		t.Fatal("oidc start echoed secret material")
	}
	var started struct {
		AuthorizationURL string    `json:"authorization_url"`
		State            string    `json:"state"`
		ExpiresAt        time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(start.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	authURL, err := url.Parse(started.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	idp.setNonce(authURL.Query().Get("nonce"))
	callback := httptest.NewRecorder()
	cb := httptest.NewRequest(http.MethodPost, "/api/v1/oidc/callback", strings.NewReader(`{"code":"good-code","state":"`+started.State+`"}`))
	cb.Header.Set("Content-Type", "application/json")
	cb.Header.Set(RequestIDHeader, "caller-request-16")
	for _, c := range start.Result().Cookies() {
		if c.Name == oidc.StateCookie {
			cb.AddCookie(c)
		}
	}
	h.ServeHTTP(callback, cb)
	if callback.Code != http.StatusCreated {
		t.Fatalf("oidc callback: %d %s", callback.Code, callback.Body.String())
	}
	if strings.Contains(callback.Body.String(), idp.secret) || strings.Contains(callback.Body.String(), idp.verifier()) || strings.Contains(callback.Body.String(), "id_token") {
		t.Fatal("oidc callback echoed secret material")
	}
	assertSessionCookies(t, callback, false)
	if idp.verifier() == "" || oidc.S256Challenge(idp.verifier()) != authURL.Query().Get("code_challenge") {
		t.Fatal("PKCE verifier was not the S256 preimage of the challenge")
	}

	mismatch := httptest.NewRecorder()
	badCB := httptest.NewRequest(http.MethodPost, "/api/v1/oidc/callback", strings.NewReader(`{"code":"good-code","state":"`+started.State+`"}`))
	badCB.Header.Set("Content-Type", "application/json")
	badCB.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(mismatch, badCB)
	assertProblem(t, mismatch, http.StatusUnauthorized, CodeUnauthenticated, "caller-request-16")

	ex := httptest.NewRecorder()
	exReq := httptest.NewRequest(http.MethodPost, "/api/v1/embed/exchange", strings.NewReader(`{}`))
	exReq.Header.Set("Content-Type", "application/json")
	exReq.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(ex, exReq)
	if ex.Code == http.StatusNotFound || ex.Code == http.StatusCreated {
		t.Fatalf("embed exchange changed: %d %s", ex.Code, ex.Body.String())
	}
	if strings.Contains(ex.Body.String(), idp.secret) {
		t.Fatal("embed exchange echoed an oidc secret")
	}
	machine := httptest.NewRecorder()
	mreq := httptest.NewRequest(http.MethodPost, "/api/v1/machine/token", strings.NewReader(`{}`))
	mreq.Header.Set("Content-Type", "application/json")
	mreq.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(machine, mreq)
	if machine.Code == http.StatusNotFound || machine.Code == http.StatusCreated {
		t.Fatalf("machine token changed: %d %s", machine.Code, machine.Body.String())
	}
}

func TestOIDCAndMFAFailClosedWhenUnconfigured(t *testing.T) {
	store := identity.NewMemory()
	h := NewWithDeps(Deps{
		Store:    store,
		Sessions: session.NewMemory(),
		PlatformAdmins: []authz.PrincipalRef{{
			Issuer:  "https://idp.example",
			Subject: "admin-1",
		}},
	})
	start := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/oidc/start", strings.NewReader(`{}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(RequestIDHeader, "caller-request-16")
	h.ServeHTTP(start, req)
	assertProblem(t, start, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
	if strings.Contains(start.Body.String(), "client_secret") {
		t.Fatal("misconfig response named a secret field value")
	}

	user := seedLocalLogin(t, store, "https://idp.example", "admin-1", "Operator", "correct-horse")
	_ = user
	login := httptest.NewRecorder()
	h.ServeHTTP(login, loginRequest(`{"identifier":"admin-1","password":"correct-horse"}`))
	if login.Code != http.StatusCreated {
		t.Fatalf("local login without oidc: %d %s", login.Code, login.Body.String())
	}
	token, csrf := sessionPair(t, login)
	denied := httptest.NewRecorder()
	h.ServeHTTP(denied, sessionAPIRequest(http.MethodGet, "/api/v1/openapi.yaml", "", token, csrf))
	assertProblem(t, denied, http.StatusForbidden, CodeMFARequired, "caller-request-16")
	enroll := httptest.NewRecorder()
	h.ServeHTTP(enroll, sessionAPIRequest(http.MethodPost, "/api/v1/session/mfa/enroll", "{}", token, csrf))
	assertProblem(t, enroll, http.StatusServiceUnavailable, CodeDependencyUnavailable, "caller-request-16")
}

func credentialRequest(method, path, token, csrf string, tenant identity.Tenant, ws identity.Workspace) *http.Request {
	req := sessionAPIRequest(method, path, "", token, csrf)
	req.Header.Set(headerTenantSlug, tenant.Slug)
	req.Header.Set(headerWorkbenchKey, ws.WorkbenchKey)
	return req
}

func totpSecret(t *testing.T, uri string) string {
	t.Helper()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	secret := u.Query().Get("secret")
	if secret == "" {
		t.Fatal("otpauth uri missing secret")
	}
	return secret
}

func mustDecodeTOTP(t *testing.T, secret string) []byte {
	t.Helper()
	raw, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(secret))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

type httpFakeIDP struct {
	url         string
	secret      string
	key         *rsa.PrivateKey
	srv         *httptest.Server
	mu          sync.Mutex
	nonce       string
	gotVerifier string
}

func newHTTPFakeIDP(t *testing.T) *httpFakeIDP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &httpFakeIDP{secret: "test-client-secret-value", key: key}
	idp.srv = httptest.NewServer(http.HandlerFunc(idp.serve))
	idp.url = idp.srv.URL
	return idp
}

func (f *httpFakeIDP) close() { f.srv.Close() }

func (f *httpFakeIDP) setNonce(n string) {
	f.mu.Lock()
	f.nonce = n
	f.mu.Unlock()
}

func (f *httpFakeIDP) verifier() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gotVerifier
}

func (f *httpFakeIDP) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                f.url,
			"authorization_endpoint":                f.url + "/authorize",
			"token_endpoint":                        f.url + "/token",
			"jwks_uri":                              f.url + "/jwks",
			"code_challenge_methods_supported":      []string{"S256"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	case "/jwks":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"keys": []any{map[string]string{
				"kty": "RSA",
				"kid": "http-1",
				"alg": "RS256",
				"use": "sig",
				"n":   base64.RawURLEncoding.EncodeToString(f.key.N.Bytes()),
				"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(f.key.E)).Bytes()),
			}},
		})
	case "/token":
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.gotVerifier = r.PostForm.Get("code_verifier")
		nonce := f.nonce
		secret := f.secret
		f.mu.Unlock()
		if r.PostForm.Get("client_secret") != secret || r.PostForm.Get("code") != "good-code" {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
			return
		}
		now := time.Now().Unix()
		header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": "http-1", "typ": "JWT"})
		payload, _ := json.Marshal(map[string]any{
			"iss": f.url, "sub": "oidc-user", "aud": "flowforge",
			"exp": now + 300, "iat": now, "nonce": nonce, "name": "Oidc User",
		})
		h := base64.RawURLEncoding.EncodeToString(header)
		p := base64.RawURLEncoding.EncodeToString(payload)
		sum := sha256.Sum256([]byte(h + "." + p))
		sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
		if err != nil {
			http.Error(w, "bad", http.StatusInternalServerError)
			return
		}
		token := h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
		_ = json.NewEncoder(w).Encode(map[string]string{"id_token": token, "token_type": "Bearer"})
	default:
		http.NotFound(w, r)
	}
}
