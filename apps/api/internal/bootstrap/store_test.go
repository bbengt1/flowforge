package bootstrap

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestMemoryIncompleteByDefault(t *testing.T) {
	st, err := NewMemory().Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	status := st.Status()
	if status.Complete || !status.Incomplete {
		t.Fatalf("fresh store must be incomplete: %+v", status)
	}
	if !status.StandaloneOnly {
		t.Fatal("standaloneOnly must be true")
	}
	if status.Steps.Persistence.Ready || status.Steps.FirstAdmin.Ready ||
		status.Steps.PublicURL.Ready || status.Steps.TLS.Ready {
		t.Fatalf("fresh steps must be unreadied: %+v", status.Steps)
	}
	assertStatusHasNoSecrets(t, status)
}

func TestMemorySeedSkipMarksComplete(t *testing.T) {
	store := NewMemory()
	if err := store.MarkSeedSkip(context.Background(), SeedSkip{}); err != nil {
		t.Fatal(err)
	}
	st, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Complete || !st.Skipped || st.PublicBaseURL != DefaultPublicBaseURL {
		t.Fatalf("seed skip %+v", st)
	}
	status := st.Status()
	if !status.Complete || status.Incomplete || !status.Skipped {
		t.Fatalf("status after skip %+v", status)
	}
	if !status.Steps.Persistence.Ready || !status.Steps.FirstAdmin.Ready || !status.Steps.PublicURL.Ready {
		t.Fatalf("seed skip steps %+v", status.Steps)
	}
	if status.Steps.TLS.Ready {
		t.Fatal("seed skip does not enable TLS (local HTTP; Settings later)")
	}
	if _, ok := statusJSON(t, status)["publicBaseUrl"]; ok {
		t.Fatal("status must not echo publicBaseUrl")
	}
	if _, ok := statusJSON(t, status)["public_base_url"]; ok {
		t.Fatal("status must not echo public_base_url")
	}
	assertStatusHasNoSecrets(t, status)
}

func TestMemorySetStepDoesNotComplete(t *testing.T) {
	store := NewMemory()
	if err := store.SetStep(context.Background(), StepPersistence, true); err != nil {
		t.Fatal(err)
	}
	if err := store.SetStep(context.Background(), StepFirstAdmin, true); err != nil {
		t.Fatal(err)
	}
	st, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.Complete {
		t.Fatal("B.2–B.5 set steps; complete is explicit (B.5 / seed skip)")
	}
	if err := store.MarkComplete(context.Background()); err != nil {
		t.Fatal(err)
	}
	st, err = store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !st.Complete {
		t.Fatal("MarkComplete must flip the gate")
	}
}

func TestMemorySetPublicURLDoesNotComplete(t *testing.T) {
	store := NewMemory()
	if err := store.SetPublicURL(context.Background(), "https://flows.example.com/"); err != nil {
		t.Fatal(err)
	}
	st, err := store.Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if st.PublicBaseURL != "https://flows.example.com" || !st.PublicURLReady {
		t.Fatalf("SetPublicURL persist: %+v", st)
	}
	if st.Complete {
		t.Fatal("SetPublicURL must not mark complete")
	}
	if _, ok := statusJSON(t, st.Status())["publicBaseUrl"]; ok {
		t.Fatal("status must not echo publicBaseUrl")
	}
	assertStatusHasNoSecrets(t, st.Status())
}

func TestMemoryRejectsInvalidStepAndURL(t *testing.T) {
	store := NewMemory()
	if err := store.SetStep(context.Background(), "kek", true); err != ErrInvalid {
		t.Fatalf("invalid step: %v", err)
	}
	if err := store.SetPublicURL(context.Background(), "not-a-url"); err != ErrInvalid {
		t.Fatalf("invalid url: %v", err)
	}
	if err := store.SetPublicURL(context.Background(), "https://user:secret@example.com"); err != ErrInvalid {
		t.Fatalf("userinfo url: %v", err)
	}
	if err := store.SetTLS(context.Background(), true, "pem-upload"); err != ErrInvalid {
		t.Fatalf("invalid tls mode: %v", err)
	}
}

func TestNormalizePublicBaseURL(t *testing.T) {
	got, err := NormalizePublicBaseURL("https://flows.example.com/")
	if err != nil || got != "https://flows.example.com" {
		t.Fatalf("got %q err=%v", got, err)
	}
	if _, err := NormalizePublicBaseURL("ftp://flows.example.com"); err != ErrInvalid {
		t.Fatalf("ftp: %v", err)
	}
}

func TestStatusJSONHasNoSecretKeys(t *testing.T) {
	st := State{
		Complete:         true,
		Skipped:          true,
		PersistenceReady: true,
		FirstAdminReady:  true,
		PublicURLReady:   true,
		TLSReady:         true,
		PublicBaseURL:    "https://flows.example.com",
		TLSMode:          TLSModeUploaded,
	}
	assertStatusHasNoSecrets(t, st.Status())
	raw := statusJSON(t, st.Status())
	if raw["complete"] != true {
		t.Fatalf("complete: %#v", raw["complete"])
	}
	if _, ok := raw["publicBaseUrl"]; ok {
		t.Fatal("public URL leaked")
	}
}

func statusJSON(t *testing.T, status Status) map[string]any {
	t.Helper()
	body, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	return raw
}

func assertStatusHasNoSecrets(t *testing.T, status Status) {
	t.Helper()
	body, err := json.Marshal(status)
	if err != nil {
		t.Fatal(err)
	}
	lower := strings.ToLower(string(body))
	for _, secret := range forbiddenStatusSubstrings {
		if strings.Contains(lower, secret) {
			t.Fatalf("status body contains forbidden %q: %s", secret, body)
		}
	}
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	walkForbiddenKeys(t, raw, "")
}

// forbiddenStatusSubstrings must never appear in GET /bootstrap JSON.
var forbiddenStatusSubstrings = []string{
	"password", "passwd", "kek", "privatekey", "private_key", "private-key",
	"credentialkek", "dek_envelope", "dek-envelope", "ciphertext",
	"-----begin", "pem",
}

var forbiddenStatusKeys = map[string]bool{
	"password": true, "passwordhash": true, "password_hash": true,
	"kek": true, "credentialkek": true, "credential_kek": true,
	"secret": true, "secrets": true, "privatekey": true, "private_key": true,
	"token": true, "tokenhash": true, "token_hash": true,
	"pem": true, "dek": true, "dekenvelope": true, "dek_envelope": true,
	"ciphertext": true, "publicbaseurl": true, "public_base_url": true,
	"hash": true, "csrf": true, "csrftoken": true,
}

func walkForbiddenKeys(t *testing.T, v any, path string) {
	t.Helper()
	switch node := v.(type) {
	case map[string]any:
		for k, child := range node {
			key := strings.ToLower(k)
			if forbiddenStatusKeys[key] {
				t.Fatalf("forbidden status field %q at %s", k, path)
			}
			walkForbiddenKeys(t, child, path+"."+k)
		}
	case []any:
		for i, child := range node {
			walkForbiddenKeys(t, child, path)
			_ = i
		}
	}
}
