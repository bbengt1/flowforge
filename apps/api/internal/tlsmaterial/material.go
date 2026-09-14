// Package tlsmaterial persists first-run TLS certificate files.
// Private keys stay on disk at the process TLS_CERT_FILE / TLS_KEY_FILE
// paths. They never enter the bootstrap store, JSON responses, or logs.
package tlsmaterial

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	maxPEMBytes   = 256 << 10
	selfSignedTTL = 365 * 24 * time.Hour
)

// ErrInvalid is a rejected certificate or key (never includes PEM text).
var ErrInvalid = errors.New("tls material invalid")

// ErrUnavailable is a missing or unwritable material destination.
var ErrUnavailable = errors.New("tls material store unavailable")

// Store writes validated PEM material to a server-side destination.
type Store interface {
	Write(certPEM, keyPEM []byte) error
}

// Files writes PEMs to the process TLS_CERT_FILE / TLS_KEY_FILE paths.
type Files struct {
	CertPath string
	KeyPath  string
}

// NewFiles returns a file store. Both paths are required (same pairing
// rule as config.TLSCertFile / TLSKeyFile). Empty or identical paths
// fail closed.
func NewFiles(certPath, keyPath string) (*Files, error) {
	certPath = strings.TrimSpace(certPath)
	keyPath = strings.TrimSpace(keyPath)
	if certPath == "" || keyPath == "" {
		return nil, ErrUnavailable
	}
	if certPath == keyPath {
		return nil, ErrUnavailable
	}
	return &Files{CertPath: certPath, KeyPath: keyPath}, nil
}

// Write validates the pair, then atomically replaces the cert and key
// files. The private key is 0600. Contents are never returned.
func (f *Files) Write(certPEM, keyPEM []byte) error {
	if f == nil || strings.TrimSpace(f.CertPath) == "" || strings.TrimSpace(f.KeyPath) == "" {
		return ErrUnavailable
	}
	if err := ValidatePair(certPEM, keyPEM); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.KeyPath), 0o700); err != nil {
		return ErrUnavailable
	}
	if err := os.MkdirAll(filepath.Dir(f.CertPath), 0o700); err != nil {
		return ErrUnavailable
	}
	if err := writeAtomic(f.KeyPath, keyPEM, 0o600); err != nil {
		return ErrUnavailable
	}
	if err := writeAtomic(f.CertPath, certPEM, 0o600); err != nil {
		return ErrUnavailable
	}
	return nil
}

func writeAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ValidatePair accepts a certificate + private key PEM. Encrypted keys
// and mismatched pairs are rejected. Error text never includes PEM.
func ValidatePair(certPEM, keyPEM []byte) error {
	if len(certPEM) == 0 || len(keyPEM) == 0 {
		return ErrInvalid
	}
	if len(certPEM) > maxPEMBytes || len(keyPEM) > maxPEMBytes {
		return ErrInvalid
	}
	if !pemLooksLikeCertificate(certPEM) || !pemLooksLikeKey(keyPEM) {
		return ErrInvalid
	}
	if _, err := tls.X509KeyPair(certPEM, keyPEM); err != nil {
		return ErrInvalid
	}
	return nil
}

func pemLooksLikeCertificate(raw []byte) bool {
	block, _ := pem.Decode(raw)
	return block != nil && block.Type == "CERTIFICATE"
}

func pemLooksLikeKey(raw []byte) bool {
	block, _ := pem.Decode(raw)
	if block == nil {
		return false
	}
	switch block.Type {
	case "PRIVATE KEY", "EC PRIVATE KEY", "RSA PRIVATE KEY":
		return true
	default:
		return false
	}
}

// CreateSelfSigned issues a one-year ECDSA P-256 server certificate.
// hosts must be DNS names and/or IP addresses (from the public URL).
func CreateSelfSigned(hosts []string, now time.Time) (certPEM, keyPEM []byte, err error) {
	hosts = normalizeHosts(hosts)
	if len(hosts) == 0 {
		return nil, nil, ErrInvalid
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	tpl := &x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			Organization: []string{"FlowForge"},
			CommonName:   hosts[0],
		},
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(selfSignedTTL),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, host := range hosts {
		if ip := net.ParseIP(host); ip != nil {
			tpl.IPAddresses = append(tpl.IPAddresses, ip)
			continue
		}
		tpl.DNSNames = append(tpl.DNSNames, host)
	}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &key.PublicKey, key)
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return nil, nil, ErrUnavailable
	}
	certPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: pkcs8})
	if err := ValidatePair(certPEM, keyPEM); err != nil {
		return nil, nil, err
	}
	return certPEM, keyPEM, nil
}

// HostsFromPublicBaseURL returns SAN hosts from a stored public origin.
// The URL itself is never a secret and is not returned to callers of
// the bootstrap HTTP API.
func HostsFromPublicBaseURL(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return nil
	}
	return normalizeHosts([]string{u.Hostname()})
}

func normalizeHosts(hosts []string) []string {
	seen := make(map[string]bool, len(hosts))
	out := make([]string, 0, len(hosts))
	for _, host := range hosts {
		host = strings.TrimSpace(host)
		if host == "" || seen[host] {
			continue
		}
		seen[host] = true
		out = append(out, host)
	}
	return out
}
