package ssh

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestNormalizeFingerprint(t *testing.T) {
	hex := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	got, err := NormalizeFingerprint("SHA256:" + strings.ToUpper(hex[:16]) + hex[16:])
	if err != nil {
		t.Fatal(err)
	}
	if got != "sha256:"+hex {
		t.Fatalf("hex canonicalize = %s", got)
	}
	colon, err := NormalizeFingerprint("sha256:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef")
	if err != nil || colon != "sha256:"+hex {
		t.Fatalf("colon hex = %s %v", colon, err)
	}
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i)
	}
	b64 := base64.RawStdEncoding.EncodeToString(raw)
	openssh, err := NormalizeFingerprint("SHA256:" + b64)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(openssh, "sha256:") || len(openssh) != 7+64 {
		t.Fatalf("openssh = %s", openssh)
	}
	for _, bad := range []string{"", "md5:aa", "sha256:zzzz", "sha256:abc", "not-a-fingerprint"} {
		if _, err := NormalizeFingerprint(bad); err == nil {
			t.Fatalf("expected rejection for %q", bad)
		}
	}
}

func TestNormalizeAddressesFailClosed(t *testing.T) {
	if _, err := NormalizeAddresses([]string{}, true); err == nil {
		t.Fatal("empty present allowlist must fail")
	}
	if got, err := NormalizeAddresses(nil, false); err != nil || got != nil {
		t.Fatalf("omitted allowlist = %v %v", got, err)
	}
	got, err := NormalizeAddresses([]string{"203.0.113.10", "203.0.113.0/24"}, true)
	if err != nil || len(got) != 2 {
		t.Fatalf("valid = %v %v", got, err)
	}
	for _, bad := range []string{"0.0.0.0/0", "::/0", "0.0.0.0", "not-an-ip", "bastion.example.com"} {
		if _, err := NormalizeAddresses([]string{bad}, true); err == nil {
			t.Fatalf("expected rejection for %q", bad)
		}
	}
}

func TestRendererQuotesAndRejects(t *testing.T) {
	schemaMap, schema, err := NormalizeParameterSchema(map[string]any{
		"type":     "object",
		"required": []any{"unit"},
		"properties": map[string]any{
			"unit": map[string]any{"type": "string", "minLength": 1, "maxLength": 64},
		},
	})
	if err != nil || schemaMap == nil {
		t.Fatal(err)
	}
	tmpl, err := NormalizeTemplate("systemctl restart {unit}", schema)
	if err != nil {
		t.Fatal(err)
	}
	out, err := Render(tmpl, schema, map[string]any{"unit": "api; rm -rf /"})
	if err != nil {
		t.Fatal(err)
	}
	if out.Command != "systemctl restart 'api; rm -rf /'" {
		t.Fatalf("quoted command = %q", out.Command)
	}
	if _, err := Render(tmpl, schema, map[string]any{"unit": "ok", "extra": "nope"}); err == nil {
		t.Fatal("extra parameter must be rejected")
	}
	_, strict, err := NormalizeParameterSchema(map[string]any{
		"type":       "object",
		"required":   []any{"unit"},
		"properties": map[string]any{"unit": map[string]any{"type": "string", "pattern": `[A-Za-z0-9._-]+`}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateParameters(strict, map[string]any{"unit": "has space"}); err == nil {
		t.Fatal("pattern mismatch must be rejected")
	}
	if _, err := NormalizeTemplate("echo $(whoami)", schema); err == nil {
		t.Fatal("interpolation must be rejected")
	}
	if _, err := NormalizeTemplate("echo {missing}", schema); err == nil {
		t.Fatal("unknown placeholder must be rejected")
	}
	if QuotePOSIX("it's") != `'it'\''s'` {
		t.Fatalf("posix quote = %s", QuotePOSIX("it's"))
	}
}

func TestParameterSchemaConstraints(t *testing.T) {
	_, _, err := NormalizeParameterSchema(map[string]any{
		"type":                 "object",
		"additionalProperties": true,
		"properties":           map[string]any{"x": map[string]any{"type": "string"}},
	})
	if err == nil {
		t.Fatal("additionalProperties true must be rejected")
	}
	_, _, err = NormalizeParameterSchema(map[string]any{
		"type":       "object",
		"properties": map[string]any{"bad-name": map[string]any{"type": "string"}},
	})
	if err == nil {
		t.Fatal("hyphenated names must be rejected")
	}
	_, schema, err := NormalizeParameterSchema(map[string]any{
		"type": "object",
		"properties": map[string]any{
			"count": map[string]any{"type": "integer", "minimum": 1, "maximum": 3},
			"ok":    map[string]any{"type": "boolean"},
		},
		"required": []any{"count"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateParameters(schema, map[string]any{"count": 2, "ok": true}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateParameters(schema, map[string]any{"count": 9}); err == nil {
		t.Fatal("maximum must reject")
	}
	if err := ValidateParameters(schema, map[string]any{}); err == nil {
		t.Fatal("required must reject")
	}
}

func TestCatalogDocumentsRendererAndRetrySchema(t *testing.T) {
	cat := Catalog()
	if cat.CredentialType != CredentialType || cat.Render.RawShellInterpolation || cat.Retry.DefaultMaxAttempts != 0 {
		t.Fatalf("catalog = %+v", cat)
	}
	if cat.Isolation.PasswordAuth || cat.Isolation.InteractiveShell || !cat.Isolation.ConnectVerifiedAddress {
		t.Fatalf("isolation = %+v", cat.Isolation)
	}
	if cat.PublishRules.CredentialType != CredentialType || !cat.PublishRules.EmptyAllowlistsRejected {
		t.Fatalf("publish rules = %+v", cat.PublishRules)
	}
	if len(cat.Nodes) != 1 || cat.Nodes[0].Type != NodeSSHRun {
		t.Fatalf("nodes = %+v", cat.Nodes)
	}
	found := false
	for _, e := range cat.Errors {
		if e.Code == CodeParameterRejected {
			found = true
		}
	}
	if !found {
		t.Fatal("expected parameter-rejected error code")
	}
}
