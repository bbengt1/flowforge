package bootstrap

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateSetupToken(t *testing.T) {
	if err := ValidateSetupToken(""); err != nil {
		t.Fatal(err)
	}
	if err := ValidateSetupToken("setup-token-value1"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"short", "admin", "setup token value1", "setup-token\nvalue1"} {
		if err := ValidateSetupToken(raw); err == nil {
			t.Fatalf("accepted %q", raw)
		} else if strings.Contains(err.Error(), raw) {
			t.Fatalf("error echoed the token: %v", err)
		}
	}
}

func TestGenerateSetupTokenHash(t *testing.T) {
	token, err := GenerateSetupToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(token) < 16 || strings.ContainsAny(token, " \n") {
		t.Fatalf("token %q", token)
	}
	hash := HashSetupToken(token)
	if !ValidSetupTokenHash(hash) || hash != strings.ToLower(hash) {
		t.Fatalf("hash %q", hash)
	}
	if !setupHashEqual(hash, HashSetupToken(token)) || setupHashEqual(hash, HashSetupToken(token+"x")) {
		t.Fatal("digest compare")
	}
}

func TestStatusOmitsSetupTokenHash(t *testing.T) {
	store := NewMemory()
	hash := HashSetupToken("setup-token-value1")
	if err := store.SetSetupTokenHash(t.Context(), hash); err != nil {
		t.Fatal(err)
	}
	st, err := store.Get(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if st.SetupTokenHash != hash {
		t.Fatal("store must keep the digest")
	}
	body, err := json.Marshal(st.Status())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), hash) {
		t.Fatalf("status leaked the digest: %s", body)
	}
	assertStatusHasNoSecrets(t, st.Status())
}
