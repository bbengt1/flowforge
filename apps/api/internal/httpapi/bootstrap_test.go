package httpapi

import (
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
