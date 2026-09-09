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
	ws := "11111111-1111-1111-1111-111111111111"
	ref := "22222222-2222-2222-2222-222222222222"
	if err := mem.Put(ws, ref, env.Ciphertext); err != nil {
		t.Fatal(err)
	}
	got, err := mem.Get(ws, ref)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(env.Ciphertext) {
		t.Fatal("memory mismatch")
	}
	if err := mem.Delete(ws, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := mem.Get(ws, ref); err != ErrNotFound {
		t.Fatalf("deleted get = %v", err)
	}

	root := t.TempDir()
	fs, err := NewFilesystemObjects(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := fs.Put(ws, ref, env.Ciphertext); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, ws, ref)
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if err := fs.Put(ws, "../escape", env.Ciphertext); err == nil {
		t.Fatal("expected path escape reject")
	}
	if err := fs.Delete(ws, ref); err != nil {
		t.Fatal(err)
	}
}

func TestAllowedContentType(t *testing.T) {
	if !AllowedContentType("text/plain") || AllowedContentType("text/html") {
		t.Fatal("allowlist")
	}
}
