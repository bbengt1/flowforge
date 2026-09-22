package artifact

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/vault"
)

func TestMemoryAndFilesystemRoundTrip(t *testing.T) {
	keys := vault.TestKeys()
	env, digest, err := Seal(keys, []byte("hello artifact"))
	if err != nil {
		t.Fatal(err)
	}
	if digest == "" {
		t.Fatal("empty digest")
	}
	plain, err := Open(keys, env)
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != "hello artifact" {
		t.Fatalf("plain = %q", plain)
	}

	mem := NewMemoryObjects()
	tenant := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ws := "11111111-1111-1111-1111-111111111111"
	ref := "22222222-2222-2222-2222-222222222222"
	if err := mem.Put(tenant, ws, ref, env.Ciphertext); err != nil {
		t.Fatal(err)
	}
	got, err := mem.Get(tenant, ws, ref)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(env.Ciphertext) {
		t.Fatal("memory mismatch")
	}
	if err := mem.Delete(tenant, ws, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := mem.Get(tenant, ws, ref); err != ErrNotFound {
		t.Fatalf("deleted get = %v", err)
	}

	root := t.TempDir()
	fs, err := NewFilesystemObjects(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := fs.Put(tenant, ws, ref, env.Ciphertext); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, tenant, ws, ref)
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Put(tenant, ws, "../escape", env.Ciphertext); err == nil {
		t.Fatal("expected path escape reject")
	}
	if err := fs.Put("not-a-tenant", ws, ref, env.Ciphertext); err == nil {
		t.Fatal("expected non-uuid tenant to fail")
	}
	if err := fs.Delete(tenant, ws, ref); err != nil {
		t.Fatal(err)
	}
}

func TestUnavailableObjectsRefusesDirectoryFallback(t *testing.T) {
	store := UnavailableObjects()
	err := store.Put("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222", []byte("x"))
	if err == nil || err.Error() != errStoreUnavailable.Error() {
		t.Fatalf("put = %v", err)
	}
	if _, err := store.Get("a", "b", "c"); err == nil {
		t.Fatal("expected get to fail")
	}
}

func TestAllowedContentType(t *testing.T) {
	if !AllowedContentType("text/plain") || AllowedContentType("text/html") {
		t.Fatal("allowlist")
	}
}
