package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/kms"
)

func TestDualKEKDecryptAndRewrap(t *testing.T) {
	oldKey := TestKeys()
	next := make([]byte, 32)
	for i := range next {
		next[i] = byte(255 - i)
	}
	plain := []byte(`{"token":"super-secret-plaintext-xyz"}`)
	env, err := Encrypt(oldKey, plain)
	if err != nil {
		t.Fatal(err)
	}
	active := Keys{KEK: next, ID: "kms:vault:newkey01", Previous: oldKey.KEK, PreviousID: oldKey.ID}
	got, err := Decrypt(active, env)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("overlap decrypt: %v", err)
	}
	out, changed, err := RewrapDEK(active, env)
	if err != nil || !changed {
		t.Fatalf("rewrap changed=%v err=%v", changed, err)
	}
	if bytes.Contains(out.DEKEnvelope, plain) || bytes.Contains(out.DEKEnvelope, next) || bytes.Contains(out.DEKEnvelope, oldKey.KEK) {
		t.Fatal("rewrap leaked key or plaintext")
	}
	if out.KeyRef != active.ID {
		t.Fatalf("key ref = %s", out.KeyRef)
	}
	onlyNew := Keys{KEK: next, ID: active.ID}
	got, err = Decrypt(onlyNew, out)
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatal("decrypt after rewrap")
	}
	if _, err := Decrypt(onlyNew, env); err != ErrDecrypt {
		t.Fatal("old envelope must not open without the previous KEK")
	}
	again, changed, err := RewrapDEK(onlyNew, out)
	if err != nil || changed || again.KeyRef != onlyNew.ID {
		t.Fatalf("second rewrap changed=%v err=%v", changed, err)
	}
}

func TestResolveKeysFailClosed(t *testing.T) {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i + 9)
	}
	encoded := base64.StdEncoding.EncodeToString(kek)
	t.Setenv(EnvKEK, encoded)
	t.Setenv(EnvKEKFile, "")
	t.Setenv(EnvKEKID, "")
	for _, name := range kms.EnvNames() {
		t.Setenv(name, "")
	}
	keys, err := ResolveKeys(context.Background(), false)
	if err != nil || !keys.Ready() || keys.ID != "env:"+EnvKEK {
		t.Fatalf("dev keys id=%s err=%v", keys.ID, err)
	}
	if _, err := ResolveKeys(context.Background(), true); err == nil {
		t.Fatal("production plaintext KEK must fail closed")
	} else {
		assertNoKEK(t, err.Error(), kek)
	}

	t.Setenv(EnvKEK, "")
	t.Setenv(kms.EnvProvider, "vault")
	if _, err := ResolveKeys(context.Background(), false); err == nil {
		t.Fatal("partial KMS must fail closed")
	} else {
		assertNoKEK(t, err.Error(), kek)
	}
}

func TestProductionUnreachableKMSDoesNotFallBackToLocalKEK(t *testing.T) {
	local := make([]byte, 32)
	for i := range local {
		local[i] = byte(i + 4)
	}
	for _, name := range kms.EnvNames() {
		t.Setenv(name, "")
	}
	blob, err := kms.EncodeBlob("vault", "flowforge", []byte("kms-ciphertext-not-the-kek"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvKEK, base64.StdEncoding.EncodeToString(local))
	t.Setenv(EnvKEKFile, "")
	t.Setenv(EnvKEKID, "env:CREDENTIAL_KEK")
	t.Setenv(kms.EnvProvider, "vault")
	t.Setenv(kms.EnvWrapped, blob)
	t.Setenv("KMS_VAULT_ADDR", "https://127.0.0.1:1")
	t.Setenv("KMS_VAULT_KEY_NAME", "flowforge")
	t.Setenv("KMS_VAULT_TOKEN", "test-vault-token")

	keys, err := ResolveKeys(context.Background(), true)
	if err == nil || keys.Ready() {
		t.Fatal("unreachable KMS must not fall back to the local KEK")
	}
	if bytes.Equal(keys.KEK, local) || bytes.Equal(keys.Previous, local) {
		t.Fatal("local KEK was returned")
	}
	assertNoKEK(t, err.Error(), local)

	t.Setenv(EnvKEK, "")
	keys, err = ResolveKeys(context.Background(), true)
	if err == nil || keys.Ready() {
		t.Fatal("unreachable KMS must fail closed with no local key")
	}
	assertNoKEK(t, err.Error(), local)
}

func assertNoKEK(t *testing.T, text string, kek []byte) {
	t.Helper()
	for _, enc := range []string{
		string(kek),
		base64.StdEncoding.EncodeToString(kek),
		hex.EncodeToString(kek),
	} {
		if strings.Contains(text, enc) {
			t.Fatal("text contained KEK material")
		}
	}
}
