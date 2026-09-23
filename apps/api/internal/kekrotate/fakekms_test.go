package kekrotate

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/kms"
)

func setVault(t *testing.T, origin string) {
	t.Helper()
	t.Setenv(kms.EnvProvider, "vault")
	t.Setenv("KMS_VAULT_ADDR", origin)
	t.Setenv("KMS_VAULT_KEY_NAME", "flowforge")
	t.Setenv("KMS_VAULT_TOKEN", "test-vault-token")
}

func startVault(t *testing.T) string {
	t.Helper()
	store := &mem{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Vault-Token") != "test-vault-token" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var req struct {
			Plaintext  string `json:"plaintext"`
			Ciphertext string `json:"ciphertext"`
		}
		if err := json.Unmarshal(body, &req); err != nil {
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
				"data": map[string]string{"ciphertext": "vault:v1:" + base64.StdEncoding.EncodeToString(token)},
			})
		case strings.Contains(r.URL.Path, "/decrypt/"):
			ct, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(req.Ciphertext, "vault:v1:"))
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
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

type mem struct {
	mu sync.Mutex
	n  int
	m  map[string][]byte
}

func (m *mem) put(kek []byte) []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.m == nil {
		m.m = map[string][]byte{}
	}
	m.n++
	token := []byte("tok" + strings.Repeat("z", m.n))
	m.m[string(token)] = append([]byte(nil), kek...)
	return token
}

func (m *mem) get(token []byte) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	kek, ok := m.m[string(token)]
	return append([]byte(nil), kek...), ok
}
