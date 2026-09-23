package kekrotate

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/bbengt1/flowforge/apps/api/internal/kms"
)

func TestWrapRotateRewrapNeverEchoesKEK(t *testing.T) {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i + 11)
	}
	clear(t)
	srv := startVault(t)
	setVault(t, srv)
	t.Setenv(kms.EnvPlainKEK, base64.StdEncoding.EncodeToString(kek))
	t.Setenv(kms.EnvKEKID, "env:CREDENTIAL_KEK")

	var wrapOut bytes.Buffer
	if err := Run(context.Background(), []string{"wrap"}, &wrapOut); err != nil {
		t.Fatal(err)
	}
	text := wrapOut.String()
	assertNoKEK(t, text, kek)
	if !strings.Contains(text, "CREDENTIAL_KEK_WRAPPED=ff1:vault:") || !strings.Contains(text, "CREDENTIAL_KEK_ID=env:CREDENTIAL_KEK") {
		t.Fatal("wrap output missing wrapped assignment")
	}
	blob := valueOf(text, "CREDENTIAL_KEK_WRAPPED")
	t.Setenv(kms.EnvPlainKEK, "")
	t.Setenv(kms.EnvWrapped, blob)
	t.Setenv(kms.EnvKEKID, "env:CREDENTIAL_KEK")

	var rotateOut bytes.Buffer
	if err := Run(context.Background(), []string{"rotate"}, &rotateOut); err != nil {
		t.Fatal(err)
	}
	rotated := rotateOut.String()
	assertNoKEK(t, rotated, kek)
	if !strings.Contains(rotated, "CREDENTIAL_KEK_PREVIOUS_ID=env:CREDENTIAL_KEK") {
		t.Fatal("rotate did not keep the previous id")
	}
	if valueOf(rotated, "CREDENTIAL_KEK_ID") == "env:CREDENTIAL_KEK" {
		t.Fatal("rotate reused the active key reference")
	}
	t.Setenv(kms.EnvWrapped, valueOf(rotated, "CREDENTIAL_KEK_WRAPPED"))
	t.Setenv(kms.EnvKEKID, valueOf(rotated, "CREDENTIAL_KEK_ID"))
	t.Setenv(kms.EnvPreviousWrapped, valueOf(rotated, "CREDENTIAL_KEK_PREVIOUS_WRAPPED"))
	t.Setenv(kms.EnvPreviousID, valueOf(rotated, "CREDENTIAL_KEK_PREVIOUS_ID"))

	var rewrapOut bytes.Buffer
	if err := Run(context.Background(), []string{"rewrap"}, &rewrapOut); err != nil {
		t.Fatal(err)
	}
	assertNoKEK(t, rewrapOut.String(), kek)
	if valueOf(rewrapOut.String(), "CREDENTIAL_KEK_ID") != valueOf(rotated, "CREDENTIAL_KEK_ID") {
		t.Fatal("cmk rewrap changed the data-key reference")
	}
}

func TestGenerateRejectsPlaintextKEK(t *testing.T) {
	clear(t)
	srv := startVault(t)
	setVault(t, srv)
	t.Setenv(kms.EnvPlainKEK, base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	err := Run(context.Background(), []string{"wrap", "--generate"}, &bytes.Buffer{})
	if err == nil {
		t.Fatal("generate with a plaintext KEK must fail closed")
	}
	assertNoKEK(t, err.Error(), bytes.Repeat([]byte{7}, 32))
}

func valueOf(text, key string) string {
	prefix := key + "="
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimPrefix(line, prefix)
		}
	}
	return ""
}

func assertNoKEK(t *testing.T, text string, kek []byte) {
	t.Helper()
	for _, enc := range []string{
		string(kek),
		base64.StdEncoding.EncodeToString(kek),
		hex.EncodeToString(kek),
	} {
		if strings.Contains(text, enc) {
			t.Fatal("output contained KEK material")
		}
	}
}

func clear(t *testing.T) {
	t.Helper()
	for _, name := range kms.EnvNames() {
		t.Setenv(name, "")
	}
	t.Setenv(kms.EnvPlainKEK, "")
	t.Setenv(kms.EnvPlainKEKFile, "")
	t.Setenv(kms.EnvKEKID, "")
	t.Setenv("APP_ENV", "development")
	t.Setenv("FLOWFORGE_ENV", "")
	t.Setenv("REQUIRE_TLS", "false")
}
