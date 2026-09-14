package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestShouldListenTLSRequiresExistingPair(t *testing.T) {
	if shouldListenTLS("", "") {
		t.Fatal("empty paths must stay HTTP")
	}
	if shouldListenTLS("/tmp/missing-cert.pem", "/tmp/missing-key.pem") {
		t.Fatal("missing files must stay HTTP so B.5 can write them")
	}

	dir := t.TempDir()
	cert := filepath.Join(dir, "cert.pem")
	key := filepath.Join(dir, "key.pem")
	if shouldListenTLS(cert, key) {
		t.Fatal("configured but absent files must stay HTTP")
	}
	if err := os.WriteFile(cert, []byte("cert"), 0o600); err != nil {
		t.Fatal(err)
	}
	if shouldListenTLS(cert, key) {
		t.Fatal("cert without key must stay HTTP")
	}
	if err := os.WriteFile(key, []byte("key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if !shouldListenTLS(cert, key) {
		t.Fatal("existing pair should enable ListenAndServeTLS")
	}
}
