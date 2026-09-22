package oidc

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
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
)

func TestPKCEHappyPathDoesNotEchoSecrets(t *testing.T) {
	idp := newFakeIDP(t)
	defer idp.close()
	client := NewClient(testSettings(idp), NewMemory())
	started, err := client.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(started)
	if strings.Contains(string(raw), idp.secret) || strings.Contains(started.AuthorizationURL, "code_verifier") || strings.Contains(started.AuthorizationURL, "client_secret") {
		t.Fatalf("start leaked secret material: %s", raw)
	}
	authURL, err := url.Parse(started.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	if authURL.Query().Get("code_challenge_method") != "S256" || authURL.Query().Get("code_challenge") == "" {
		t.Fatalf("authorize query: %s", authURL.RawQuery)
	}
	idp.setNonce(authURL.Query().Get("nonce"))
	ident, err := client.Complete(t.Context(), "good-code", started.State)
	if err != nil {
		t.Fatal(err)
	}
	if ident.Subject != "user-1" || ident.Issuer != idp.url || ident.DisplayName != "Ada" {
		t.Fatalf("identity: %+v", ident)
	}
	if idp.verifier() == "" || S256Challenge(idp.verifier()) != authURL.Query().Get("code_challenge") {
		t.Fatal("token request verifier did not match the authorize challenge")
	}
	if idp.clientSecret() != idp.secret {
		t.Fatal("token endpoint did not receive the server-side client secret")
	}
	if _, err := client.Complete(t.Context(), "good-code", started.State); err == nil {
		t.Fatal("state replay must fail")
	}
}

func TestPKCERejectsBadCodeNonceAndAlg(t *testing.T) {
	idp := newFakeIDP(t)
	defer idp.close()
	client := NewClient(testSettings(idp), NewMemory())

	started, err := client.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Complete(t.Context(), "good-code", "not-the-state"); err == nil {
		t.Fatal("bad state must fail")
	}

	authURL, err := url.Parse(started.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	idp.setNonce(authURL.Query().Get("nonce"))
	idp.rejectCode = true
	if _, err := client.Complete(t.Context(), "bad-code", started.State); err == nil {
		t.Fatal("bad code must fail")
	}

	started, err = client.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	idp.rejectCode = false
	idp.useWrongNonce = true
	if _, err := client.Complete(t.Context(), "good-code", started.State); err == nil {
		t.Fatal("nonce mismatch must fail")
	}

	started, err = client.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	authURL, err = url.Parse(started.AuthorizationURL)
	if err != nil {
		t.Fatal(err)
	}
	idp.useWrongNonce = false
	idp.algNone = true
	idp.setNonce(authURL.Query().Get("nonce"))
	if _, err := client.Complete(t.Context(), "good-code", started.State); err == nil {
		t.Fatal("alg=none must fail")
	}
}

func TestStartFailClosedWhenUnconfigured(t *testing.T) {
	client := NewClient(Settings{}, NewMemory())
	if _, err := client.Start(t.Context()); err != ErrNotConfigured {
		t.Fatalf("start: %v", err)
	}
	if _, err := client.Complete(t.Context(), "c", "s"); err != ErrNotConfigured {
		t.Fatalf("complete: %v", err)
	}
}

type fakeIDP struct {
	url           string
	secret        string
	key           *rsa.PrivateKey
	kid           string
	srv           *httptest.Server
	mu            sync.Mutex
	nonce         string
	gotVerifier   string
	gotSecret     string
	rejectCode    bool
	useWrongNonce bool
	algNone       bool
}

func newFakeIDP(t *testing.T) *fakeIDP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	idp := &fakeIDP{secret: "test-client-secret-value", key: key, kid: "test-1"}
	idp.srv = httptest.NewServer(http.HandlerFunc(idp.serve))
	idp.url = idp.srv.URL
	return idp
}

func (f *fakeIDP) close() { f.srv.Close() }

func (f *fakeIDP) setNonce(n string) {
	f.mu.Lock()
	f.nonce = n
	f.mu.Unlock()
}

func (f *fakeIDP) verifier() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gotVerifier
}

func (f *fakeIDP) clientSecret() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gotSecret
}

func (f *fakeIDP) serve(w http.ResponseWriter, r *http.Request) {
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
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []any{publicJWK(f.key, f.kid)}})
	case "/token":
		f.token(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeIDP) token(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	f.gotVerifier = r.PostForm.Get("code_verifier")
	f.gotSecret = r.PostForm.Get("client_secret")
	nonce := f.nonce
	reject := f.rejectCode
	wrong := f.useWrongNonce
	none := f.algNone
	secret := f.secret
	f.mu.Unlock()
	if r.PostForm.Get("client_secret") != secret || r.PostForm.Get("code") != "good-code" || reject {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "invalid_grant"})
		return
	}
	if wrong {
		nonce = "wrong-nonce"
	}
	now := time.Now().Unix()
	claims := map[string]any{
		"iss":   f.url,
		"sub":   "user-1",
		"aud":   "flowforge",
		"exp":   now + 300,
		"iat":   now,
		"nonce": nonce,
		"name":  "Ada",
	}
	var token string
	if none {
		token = unsignedToken(claims)
	} else {
		token = signToken(f.key, f.kid, claims)
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"id_token": token, "token_type": "Bearer"})
}

func testSettings(idp *fakeIDP) Settings {
	return Settings{
		Issuer:       idp.url,
		ClientID:     "flowforge",
		ClientSecret: idp.secret,
		RedirectURI:  "https://app.example/api/v1/oidc/callback",
		Scopes:       defaultScopes,
		StateKey:     []byte("0123456789abcdef0123456789abcdef"),
	}
}

func publicJWK(key *rsa.PrivateKey, kid string) map[string]string {
	return map[string]string{
		"kty": "RSA",
		"kid": kid,
		"alg": "RS256",
		"use": "sig",
		"n":   base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e":   base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	}
}

func signToken(key *rsa.PrivateKey, kid string, claims map[string]any) string {
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "kid": kid, "typ": "JWT"})
	payload, _ := json.Marshal(claims)
	h := base64.RawURLEncoding.EncodeToString(header)
	p := base64.RawURLEncoding.EncodeToString(payload)
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		panic(err)
	}
	return h + "." + p + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func unsignedToken(claims map[string]any) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	payload, _ := json.Marshal(claims)
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + "."
}
