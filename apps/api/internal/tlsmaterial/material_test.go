package tlsmaterial

import (
	"crypto/tls"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCreateSelfSignedRoundTrip(t *testing.T) {
	certPEM, keyPEM, err := CreateSelfSigned([]string{"flows.example.com"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidatePair(certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(certPEM), "BEGIN CERTIFICATE") {
		t.Fatal("expected certificate PEM")
	}
	if !strings.Contains(string(keyPEM), "BEGIN PRIVATE KEY") {
		t.Fatal("expected PKCS#8 key PEM")
	}
}

func TestCreateSelfSignedRequiresHost(t *testing.T) {
	if _, _, err := CreateSelfSigned(nil, time.Time{}); err != ErrInvalid {
		t.Fatalf("empty hosts: %v", err)
	}
}

func TestValidatePairRejectsGarbageAndMismatch(t *testing.T) {
	if err := ValidatePair(nil, nil); err != ErrInvalid {
		t.Fatalf("empty: %v", err)
	}
	certPEM, keyPEM, err := CreateSelfSigned([]string{"a.example"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	otherCert, otherKey, err := CreateSelfSigned([]string{"b.example"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidatePair(certPEM, otherKey); err != ErrInvalid {
		t.Fatalf("mismatched pair: %v", err)
	}
	if err := ValidatePair(otherCert, keyPEM); err != ErrInvalid {
		t.Fatalf("mismatched pair: %v", err)
	}
	if err := ValidatePair([]byte("not-pem"), keyPEM); err != ErrInvalid {
		t.Fatalf("garbage cert: %v", err)
	}
}

func TestFilesWriteAtomicAndRestrictive(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFiles(filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key"))
	if err != nil {
		t.Fatal(err)
	}
	certPEM, keyPEM, err := CreateSelfSigned([]string{"localhost"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Write(certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	gotCert, err := os.ReadFile(store.CertPath)
	if err != nil {
		t.Fatal(err)
	}
	gotKey, err := os.ReadFile(store.KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotCert) != string(certPEM) {
		t.Fatal("cert file mismatch")
	}
	if string(gotKey) != string(keyPEM) {
		t.Fatal("key file mismatch")
	}
	info, err := os.Stat(store.KeyPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("key perm = %o", info.Mode().Perm())
	}
}

func TestFilesWriteCreatesParentDir(t *testing.T) {
	dir := t.TempDir()
	nested := filepath.Join(dir, "flowforge-tls")
	store, err := NewFiles(filepath.Join(nested, "cert.pem"), filepath.Join(nested, "key.pem"))
	if err != nil {
		t.Fatal(err)
	}
	certPEM, keyPEM, err := CreateSelfSigned([]string{"localhost"}, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Write(certPEM, keyPEM); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(nested)
	if err != nil {
		t.Fatal(err)
	}
	if !info.IsDir() {
		t.Fatal("expected parent directory")
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("parent perm = %o", info.Mode().Perm())
	}
	if _, err := os.Stat(store.CertPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(store.KeyPath); err != nil {
		t.Fatal(err)
	}
}

func TestNewFilesFailClosed(t *testing.T) {
	if _, err := NewFiles("", "/tmp/key.pem"); err != ErrUnavailable {
		t.Fatalf("empty cert: %v", err)
	}
	if _, err := NewFiles("/tmp/cert.pem", "/tmp/cert.pem"); err != ErrUnavailable {
		t.Fatalf("same path: %v", err)
	}
}

func TestFilesWriteRejectsInvalidWithoutCreating(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFiles(filepath.Join(dir, "tls.crt"), filepath.Join(dir, "tls.key"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Write([]byte("nope"), []byte("nope")); err != ErrInvalid {
		t.Fatalf("invalid write: %v", err)
	}
	if _, err := os.Stat(store.CertPath); !os.IsNotExist(err) {
		t.Fatal("invalid write must not create cert")
	}
	if _, err := os.Stat(store.KeyPath); !os.IsNotExist(err) {
		t.Fatal("invalid write must not create key")
	}
}

func TestHostsFromPublicBaseURL(t *testing.T) {
	got := HostsFromPublicBaseURL("https://flows.example.com:8443/")
	if len(got) != 1 || got[0] != "flows.example.com" {
		t.Fatalf("got %#v", got)
	}
	if HostsFromPublicBaseURL("") != nil {
		t.Fatal("empty URL")
	}
}
