package kms

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func TestWrapUnwrapProviders(t *testing.T) {
	kek := testKEK()
	cases := []struct {
		name   string
		kind   string
		setEnv func(t *testing.T, origin string)
	}{
		{name: "aws", kind: "aws", setEnv: setAWSEnv},
		{name: "gcp", kind: "gcp", setEnv: setGCPEnv},
		{name: "azure", kind: "azure", setEnv: setAzureEnv},
		{name: "vault", kind: "vault", setEnv: setVaultEnv},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clearKMSEnv(t)
			srv := newFakeKMS(t, tc.kind, false)
			tc.setEnv(t, srv.URL)
			p, err := Open(false)
			if err != nil {
				t.Fatal(err)
			}
			blob, err := WrapBlob(context.Background(), p, kek)
			if err != nil {
				t.Fatal(err)
			}
			assertNoKeyMaterial(t, "blob", blob, kek)
			if !strings.HasPrefix(blob, "ff1:"+tc.name+":") {
				t.Fatalf("blob prefix = %s", blob[:min(24, len(blob))])
			}
			got, err := UnwrapBlob(context.Background(), p, blob)
			if err != nil {
				t.Fatal(err)
			}
			if hex.EncodeToString(got) != hex.EncodeToString(kek) {
				t.Fatal("unwrapped KEK mismatch")
			}
		})
	}
}

func TestKMSErrorDoesNotEchoPlaintext(t *testing.T) {
	kek := testKEK()
	encoded := base64.StdEncoding.EncodeToString(kek)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, encoded)
	}))
	t.Cleanup(srv.Close)
	clearKMSEnv(t)
	setVaultEnv(t, srv.URL)
	p, err := Open(false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = WrapBlob(context.Background(), p, kek)
	if err == nil {
		t.Fatal("expected wrap failure")
	}
	assertNoKeyMaterial(t, "error", err.Error(), kek)
	if strings.Contains(err.Error(), encoded) {
		t.Fatal("error echoed KEK")
	}
}

func TestPartialKMSConfigFailsClosed(t *testing.T) {
	clearKMSEnv(t)
	t.Setenv(EnvProvider, "")
	t.Setenv(envAWSRegion, "us-east-1")
	_, err := Open(false)
	if err == nil || !strings.Contains(err.Error(), EnvProvider) {
		t.Fatalf("partial = %v", err)
	}
	assertNoKeyMaterial(t, "partial", err.Error(), testKEK())

	clearKMSEnv(t)
	t.Setenv(EnvProvider, "vault")
	_, err = Open(true)
	if err == nil {
		t.Fatal("incomplete vault config must fail")
	}
	assertNoKeyMaterial(t, "incomplete", err.Error(), testKEK())

	clearKMSEnv(t)
	t.Setenv(EnvProvider, "aws")
	t.Setenv(envAWSRegion, "us-east-1")
	t.Setenv(envAWSKeyID, "alias/flowforge")
	t.Setenv(envAWSAccess, "test-access-key")
	t.Setenv(envAWSSecret, base64.StdEncoding.EncodeToString(testKEK()))
	t.Setenv(envAWSEndpoint, "http://example.com")
	_, err = Open(true)
	if err == nil || strings.Contains(err.Error(), base64.StdEncoding.EncodeToString(testKEK())) {
		t.Fatalf("production http endpoint = %v", err)
	}
}

func TestBlobRejectsPlaintextAndWrongProvider(t *testing.T) {
	kek := testKEK()
	blob, err := EncodeBlob("vault", "flowforge", []byte("ciphertext-not-the-kek"))
	if err != nil {
		t.Fatal(err)
	}
	provider, keyID, ct, err := DecodeBlob(blob)
	if err != nil || provider != "vault" || keyID != "flowforge" || string(ct) != "ciphertext-not-the-kek" {
		t.Fatalf("decode = %s %s %q %v", provider, keyID, ct, err)
	}
	if _, _, _, err := DecodeBlob("ff1:vault:" + base64.RawURLEncoding.EncodeToString(kek)); err == nil {
		t.Fatal("short blob must fail")
	}
	clearKMSEnv(t)
	srv := newFakeKMS(t, "gcp", false)
	setGCPEnv(t, srv.URL)
	p, err := Open(false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = UnwrapBlob(context.Background(), p, blob)
	if err == nil || strings.Contains(err.Error(), string(kek)) {
		t.Fatalf("provider mismatch = %v", err)
	}
}

func testKEK() []byte {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i + 7)
	}
	return kek
}

func assertNoKeyMaterial(t *testing.T, label, text string, kek []byte) {
	t.Helper()
	if strings.Contains(text, string(kek)) {
		t.Fatalf("%s contained raw KEK", label)
	}
	for _, enc := range []string{
		base64.StdEncoding.EncodeToString(kek),
		base64.RawStdEncoding.EncodeToString(kek),
		base64.URLEncoding.EncodeToString(kek),
		hex.EncodeToString(kek),
	} {
		if enc != "" && strings.Contains(text, enc) {
			t.Fatalf("%s contained encoded KEK", label)
		}
	}
}

func clearKMSEnv(t *testing.T) {
	t.Helper()
	for _, name := range EnvNames() {
		t.Setenv(name, "")
	}
	t.Setenv(EnvPlainKEK, "")
	t.Setenv(EnvPlainKEKFile, "")
	t.Setenv(EnvKEKID, "")
	t.Setenv("AWS_REGION", "")
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "")
	t.Setenv("AWS_SESSION_TOKEN", "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("REQUIRE_TLS", "")
}

func setAWSEnv(t *testing.T, origin string) {
	t.Helper()
	t.Setenv(EnvProvider, "aws")
	t.Setenv(envAWSRegion, "us-east-1")
	t.Setenv(envAWSKeyID, "alias/flowforge")
	t.Setenv(envAWSAccess, "test-access-key")
	t.Setenv(envAWSSecret, "test-secret-key")
	t.Setenv(envAWSEndpoint, origin)
}

func setGCPEnv(t *testing.T, origin string) {
	t.Helper()
	t.Setenv(EnvProvider, "gcp")
	t.Setenv(envGCPKey, "projects/p/locations/l/keyRings/r/cryptoKeys/k")
	t.Setenv(envGCPToken, "test-gcp-token")
	t.Setenv(envGCPEndpoint, origin)
}

func setAzureEnv(t *testing.T, origin string) {
	t.Helper()
	t.Setenv(EnvProvider, "azure")
	t.Setenv(envAzureVault, origin)
	t.Setenv(envAzureKey, "flowforge-kek")
	t.Setenv(envAzureVersion, "v1")
	t.Setenv(envAzureToken, "test-azure-token")
}

func setVaultEnv(t *testing.T, origin string) {
	t.Helper()
	t.Setenv(EnvProvider, "vault")
	t.Setenv(envVaultAddr, origin)
	t.Setenv(envVaultKey, "flowforge")
	t.Setenv(envVaultToken, "test-vault-token")
}

type memKMS struct {
	mu sync.Mutex
	n  int
	m  map[string][]byte
}

func (m *memKMS) put(kek []byte) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.m == nil {
		m.m = map[string][]byte{}
	}
	m.n++
	token := []byte("tok-" + strings.Repeat("x", m.n))
	m.m[string(token)] = append([]byte(nil), kek...)
	return token
}

func (m *memKMS) get(token []byte) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	kek, ok := m.m[string(token)]
	if !ok {
		return nil, false
	}
	return append([]byte(nil), kek...), true
}

func newFakeKMS(t *testing.T, kind string, echo bool) *httptest.Server {
	t.Helper()
	store := &memKMS{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if echo {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write(body)
			return
		}
		switch kind {
		case "aws":
			serveAWS(t, w, r, body, store)
		case "gcp":
			serveGCP(w, r, body, store)
		case "azure":
			serveAzure(w, r, body, store)
		case "vault":
			serveVault(w, r, body, store)
		default:
			http.Error(w, "no", http.StatusBadRequest)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func serveAWS(t *testing.T, w http.ResponseWriter, r *http.Request, body []byte, store *memKMS) {
	t.Helper()
	w.Header().Set("Content-Type", "application/x-amz-json-1.1")
	target := r.Header.Get("X-Amz-Target")
	switch {
	case strings.HasSuffix(target, ".Encrypt"):
		var full struct {
			Plaintext         string            `json:"Plaintext"`
			KeyId             string            `json:"KeyId"`
			EncryptionContext map[string]string `json:"EncryptionContext"`
		}
		if err := json.Unmarshal(body, &full); err != nil || full.KeyId == "" || full.EncryptionContext["purpose"] != Purpose {
			t.Logf("aws encrypt target %q", target)
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		pt, err := base64.StdEncoding.DecodeString(full.Plaintext)
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		token := store.put(pt)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"CiphertextBlob": base64.StdEncoding.EncodeToString(token),
			"KeyId":          full.KeyId,
		})
	case strings.HasSuffix(target, ".Decrypt"):
		var full struct {
			CiphertextBlob    string            `json:"CiphertextBlob"`
			EncryptionContext map[string]string `json:"EncryptionContext"`
		}
		if err := json.Unmarshal(body, &full); err != nil || full.EncryptionContext["purpose"] != Purpose {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		ct, err := base64.StdEncoding.DecodeString(full.CiphertextBlob)
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		pt, ok := store.get(ct)
		if !ok {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"Plaintext": base64.StdEncoding.EncodeToString(pt),
			"KeyId":     "alias/flowforge",
		})
	default:
		t.Logf("unexpected target %q", target)
		http.Error(w, "bad", http.StatusBadRequest)
	}
}

func serveGCP(w http.ResponseWriter, r *http.Request, body []byte, store *memKMS) {
	if r.Header.Get("Authorization") != "Bearer test-gcp-token" {
		http.Error(w, "no", http.StatusUnauthorized)
		return
	}
	var req struct {
		Plaintext string `json:"plaintext"`
		Cipher    string `json:"ciphertext"`
		AAD       string `json:"additionalAuthenticatedData"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.AAD == "" {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	switch {
	case strings.HasSuffix(r.URL.Path, ":encrypt"):
		pt, err := base64.StdEncoding.DecodeString(req.Plaintext)
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		token := store.put(pt)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"ciphertext": base64.StdEncoding.EncodeToString(token),
		})
	case strings.HasSuffix(r.URL.Path, ":decrypt"):
		ct, err := base64.StdEncoding.DecodeString(req.Cipher)
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		pt, ok := store.get(ct)
		if !ok {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{
			"plaintext": base64.StdEncoding.EncodeToString(pt),
		})
	default:
		http.Error(w, "bad", http.StatusNotFound)
	}
}

func serveAzure(w http.ResponseWriter, r *http.Request, body []byte, store *memKMS) {
	if r.Header.Get("Authorization") != "Bearer test-azure-token" {
		http.Error(w, "no", http.StatusUnauthorized)
		return
	}
	var req struct {
		Alg   string `json:"alg"`
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Alg != "RSA-OAEP-256" {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	raw, err := base64.RawURLEncoding.DecodeString(req.Value)
	if err != nil {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	var out []byte
	switch {
	case strings.Contains(r.URL.Path, "/wrapkey"):
		out = store.put(raw)
	case strings.Contains(r.URL.Path, "/unwrapkey"):
		pt, ok := store.get(raw)
		if !ok {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		out = pt
	default:
		http.Error(w, "bad", http.StatusNotFound)
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{
		"kid":   "test",
		"value": base64.RawURLEncoding.EncodeToString(out),
	})
}

func serveVault(w http.ResponseWriter, r *http.Request, body []byte, store *memKMS) {
	if r.Header.Get("X-Vault-Token") != "test-vault-token" {
		http.Error(w, "no", http.StatusForbidden)
		return
	}
	var req struct {
		Plaintext  string `json:"plaintext"`
		Ciphertext string `json:"ciphertext"`
		Context    string `json:"context"`
	}
	if err := json.Unmarshal(body, &req); err != nil || req.Context == "" {
		http.Error(w, "bad", http.StatusBadRequest)
		return
	}
	switch {
	case strings.Contains(r.URL.Path, "/encrypt/"):
		pt, err := base64.StdEncoding.DecodeString(req.Plaintext)
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		token := store.put(pt)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]string{
				"ciphertext": "vault:v1:" + base64.StdEncoding.EncodeToString(token),
			},
		})
	case strings.Contains(r.URL.Path, "/decrypt/"):
		enc := strings.TrimPrefix(req.Ciphertext, "vault:v1:")
		ct, err := base64.StdEncoding.DecodeString(enc)
		if err != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		pt, ok := store.get(ct)
		if !ok {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": map[string]string{"plaintext": base64.StdEncoding.EncodeToString(pt)},
		})
	default:
		http.Error(w, "bad", http.StatusNotFound)
	}
}
