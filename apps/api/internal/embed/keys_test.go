package embed

import (
	"bytes"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/authz"
)

func TestLoadMaterialProductionMissingKeyFails(t *testing.T) {
	t.Setenv(EnvSigningKey, "")
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(EnvSigningKeyID, "")
	t.Setenv(authz.EnvAppEnv, "")
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv("REQUIRE_TLS", "")

	_, err := LoadMaterial()
	if !errors.Is(err, ErrSigningKeyRequired) {
		t.Fatalf("empty production: %v", err)
	}

	t.Setenv(authz.EnvAppEnv, "production")
	_, err = LoadMaterial()
	if !errors.Is(err, ErrSigningKeyRequired) {
		t.Fatalf("APP_ENV=production: %v", err)
	}

	t.Setenv(authz.EnvAppEnv, "staging")
	_, err = LoadMaterial()
	if !errors.Is(err, ErrSigningKeyRequired) {
		t.Fatalf("unknown APP_ENV is production-locked: %v", err)
	}

	t.Setenv(authz.EnvAppEnv, "development")
	t.Setenv("REQUIRE_TLS", "true")
	_, err = LoadMaterial()
	if !errors.Is(err, ErrSigningKeyRequired) {
		t.Fatalf("REQUIRE_TLS: %v", err)
	}
}

func TestLoadMaterialNonProductionAllowsEphemeral(t *testing.T) {
	t.Setenv(EnvSigningKey, "")
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv("REQUIRE_TLS", "")
	for _, env := range []string{"development", "dev", "local", "test"} {
		t.Setenv(authz.EnvAppEnv, env)
		m, err := LoadMaterial()
		if err != nil {
			t.Fatalf("%s: %v", env, err)
		}
		if !m.Ready() || !m.Ephemeral() {
			t.Fatalf("%s: ready=%v ephemeral=%v kid=%q", env, m.Ready(), m.Ephemeral(), m.KeyID)
		}
	}
}

func TestLoadMaterialPKCS8PEM(t *testing.T) {
	fixture := TestMaterial()
	pem := EncodePKCS8PEM(fixture.Private)
	if !strings.Contains(pem, "BEGIN PRIVATE KEY") {
		t.Fatalf("EncodePKCS8PEM: %q", pem)
	}
	t.Setenv(EnvSigningKey, pem)
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(EnvSigningKeyID, "pkcs8:ops")
	t.Setenv(authz.EnvAppEnv, "production")
	t.Setenv("REQUIRE_TLS", "true")

	m, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if m.Ephemeral() || !m.Ready() || m.KeyID != "pkcs8:ops" {
		t.Fatalf("PKCS8 material %+v", m)
	}
	if !bytes.Equal(m.Private, fixture.Private) || !bytes.Equal(m.Public, fixture.Public) {
		t.Fatal("PKCS8 PEM must load the same Ed25519 key")
	}
}

func TestLoadMaterialPKCS8PEMEscapedNewlines(t *testing.T) {
	fixture := TestMaterial()
	pem := strings.ReplaceAll(strings.TrimSpace(EncodePKCS8PEM(fixture.Private)), "\n", `\n`)
	t.Setenv(EnvSigningKey, pem)
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(authz.EnvAppEnv, "production")

	m, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m.Private, fixture.Private) {
		t.Fatal("escaped-newline PKCS8 PEM must load")
	}
}

func TestLoadMaterialInvalidPEMRejected(t *testing.T) {
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(authz.EnvAppEnv, "production")
	cases := []string{
		"-----BEGIN PRIVATE KEY-----\nnot-valid-base64\n-----END PRIVATE KEY-----",
		"-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
		EncodePKIXPublicPEM(TestMaterial().Public),
		"-----BEGIN PRIVATE KEY-----",
	}
	for _, raw := range cases {
		t.Setenv(EnvSigningKey, raw)
		if _, err := LoadMaterial(); err == nil {
			t.Fatalf("expected reject for %q", raw)
		}
	}
}

func TestParsePublicSPKIPEM(t *testing.T) {
	fixture := TestMaterial()
	pem := EncodePKIXPublicPEM(fixture.Public)
	pub, err := parsePublicSPKIPEM(pem)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pub, fixture.Public) {
		t.Fatal("SPKI PEM must parse via x509.ParsePKIXPublicKey")
	}
	if _, err := parsePublicSPKIPEM("-----BEGIN PUBLIC KEY-----\nnope\n-----END PUBLIC KEY-----"); err == nil {
		t.Fatal("invalid SPKI PEM must be rejected")
	}
}

func TestLoadMaterialDurableKeyIsStable(t *testing.T) {
	pem := EncodePKCS8PEM(TestMaterial().Private)
	t.Setenv(EnvSigningKey, pem)
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(EnvSigningKeyID, "stable:ops")
	t.Setenv(authz.EnvAppEnv, "production")
	t.Setenv("REQUIRE_TLS", "true")

	first, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if first.Ephemeral() || first.KeyID != "stable:ops" {
		t.Fatalf("durable key must not be ephemeral: %+v", first)
	}
	if string(first.Private) != string(second.Private) || string(first.Public) != string(second.Public) {
		t.Fatal("durable key must be identical across loads")
	}
}

func TestLoadMaterialFileSource(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/embed.pem"
	fixture := TestMaterial()
	if err := os.WriteFile(path, []byte(EncodePKCS8PEM(fixture.Private)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvSigningKey, "")
	t.Setenv(EnvSigningKeyFile, path)
	t.Setenv(EnvSigningKeyID, "")
	t.Setenv(authz.EnvAppEnv, "production")

	m, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if m.Ephemeral() || !m.Ready() || m.KeyID != "file:"+EnvSigningKeyFile {
		t.Fatalf("file material %+v", m)
	}
	if !bytes.Equal(m.Private, fixture.Private) {
		t.Fatal("file material must match the temp-dir PKCS8 PEM")
	}
}

func TestLoadMaterialLegacySeedCompatibility(t *testing.T) {
	fixture := TestMaterial()
	t.Setenv(EnvSigningKey, EncodeSeedB64(fixture.Private))
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(authz.EnvAppEnv, "production")

	m, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m.Private, fixture.Private) {
		t.Fatal("legacy raw seed must still load")
	}
}

func TestLoadMaterialEnvKeyPrefersOverFile(t *testing.T) {
	envKey := TestMaterial()
	fileKey := TestMaterial()
	dir := t.TempDir()
	path := dir + "/embed.pem"
	if err := os.WriteFile(path, []byte(EncodePKCS8PEM(fileKey.Private)), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(EnvSigningKey, EncodePKCS8PEM(envKey.Private))
	t.Setenv(EnvSigningKeyFile, path)
	t.Setenv(authz.EnvAppEnv, "production")

	m, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(m.Private, envKey.Private) {
		t.Fatal("EMBED_SIGNING_KEY must win over FILE when both are set")
	}
}

func TestNewEphemeralMaterialIsRandom(t *testing.T) {
	first := NewEphemeralMaterial()
	second := NewEphemeralMaterial()
	if !first.Ready() || !first.Ephemeral() {
		t.Fatalf("first %+v", first)
	}
	if bytes.Equal(first.Private, second.Private) || bytes.Equal(first.Public, second.Public) {
		t.Fatal("ephemeral keys must not share a committed seed")
	}
}

func TestTestMaterialIsRandomAndNonProduction(t *testing.T) {
	first := TestMaterial()
	second := TestMaterial()
	if first.Ephemeral() || first.KeyID != "test:EMBED_SIGNING_KEY" {
		t.Fatalf("test helper must stay non-production: %+v", first)
	}
	if bytes.Equal(first.Private, second.Private) {
		t.Fatal("test material must not reuse a fixed seed")
	}
}

func TestLoadMaterialNonProductionEphemeralIsRandom(t *testing.T) {
	t.Setenv(EnvSigningKey, "")
	t.Setenv(EnvSigningKeyFile, "")
	t.Setenv(authz.EnvAppEnv, "development")
	t.Setenv(authz.EnvFlowforgeEnv, "")
	t.Setenv("REQUIRE_TLS", "")

	first, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	second, err := LoadMaterial()
	if err != nil {
		t.Fatal(err)
	}
	if !first.Ephemeral() || !second.Ephemeral() {
		t.Fatalf("non-prod empty key must be ephemeral: %q %q", first.KeyID, second.KeyID)
	}
	if bytes.Equal(first.Private, second.Private) {
		t.Fatal("non-prod ephemeral loads must not mint the same key")
	}
}
