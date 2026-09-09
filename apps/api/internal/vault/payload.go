package vault

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Typed credential kinds from the UI/security specs.
const (
	TypeKubernetes    = "kubernetes"
	TypeSSHPrivateKey = "ssh_private_key"
	TypeToken         = "token"
	TypeWebhookSecret = "webhook_secret"
	TypeProvider      = "provider"
)

// Lifecycle and test statuses.
const (
	StatusActive   = "active"
	StatusDisabled = "disabled"

	TestUntested = "untested"
	TestPassed   = "passed"
	TestFailed   = "failed"
)

const (
	maxDisplayName = 200
	maxSecretBytes = 256 * 1024
	maxTags        = 16
	maxTagLen      = 40
	maxMetaKeys    = 16
	maxMetaLen     = 200
	minTokenLen    = 8
)

// ValidTypes is the closed set the API accepts.
func ValidTypes() []string {
	return []string{TypeKubernetes, TypeSSHPrivateKey, TypeToken, TypeWebhookSecret, TypeProvider}
}

func validType(t string) bool {
	for _, k := range ValidTypes() {
		if k == t {
			return true
		}
	}
	return false
}

// Catalog describes typed secret/metadata fields for the UI. Values are never included.
type Catalog struct {
	Types []TypeInfo `json:"types"`
}

// TypeInfo is safe field shape for the add/rotate wizard.
type TypeInfo struct {
	Type           string      `json:"type"`
	DisplayName    string      `json:"displayName"`
	SecretFields   []FieldInfo `json:"secretFields"`
	MetadataFields []FieldInfo `json:"metadataFields"`
}

// FieldInfo names a form field. It never carries a value.
type FieldInfo struct {
	Name     string `json:"name"`
	Input    string `json:"input"`
	Required bool   `json:"required"`
}

// TypeCatalog is the UI contract for credential types.
func TypeCatalog() Catalog {
	return Catalog{Types: []TypeInfo{
		{
			Type:        TypeKubernetes,
			DisplayName: "Kubernetes kubeconfig",
			SecretFields: []FieldInfo{
				{Name: "kubeconfig", Input: "textarea", Required: true},
			},
			MetadataFields: []FieldInfo{
				{Name: "contextName", Input: "text"},
			},
		},
		{
			Type:        TypeSSHPrivateKey,
			DisplayName: "SSH private key",
			SecretFields: []FieldInfo{
				{Name: "privateKey", Input: "textarea", Required: true},
				{Name: "passphrase", Input: "password", Required: false},
			},
			MetadataFields: []FieldInfo{
				{Name: "keyType", Input: "text"},
			},
		},
		{
			Type:        TypeToken,
			DisplayName: "Token / API key",
			SecretFields: []FieldInfo{
				{Name: "token", Input: "password", Required: true},
			},
			MetadataFields: []FieldInfo{
				{Name: "tokenKind", Input: "text"},
			},
		},
		{
			Type:        TypeWebhookSecret,
			DisplayName: "Webhook secret",
			SecretFields: []FieldInfo{
				{Name: "secret", Input: "password", Required: true},
			},
		},
		{
			Type:        TypeProvider,
			DisplayName: "Provider connector",
			SecretFields: []FieldInfo{
				{Name: "token", Input: "password", Required: true},
			},
			MetadataFields: []FieldInfo{
				{Name: "provider", Input: "text"},
			},
		},
	}}
}

func canonicalizeSecret(typ string, secret map[string]string) ([]byte, string, error) {
	if secret == nil {
		return nil, "", fmt.Errorf("secret is required")
	}
	cleaned := map[string]string{}
	for k, v := range secret {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		cleaned[k] = v
	}
	if err := validateSecretShape(typ, cleaned); err != nil {
		return nil, "", err
	}
	keys := make([]string, 0, len(cleaned))
	for k := range cleaned {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	canonical := make(map[string]string, len(keys))
	for _, k := range keys {
		canonical[k] = cleaned[k]
	}
	raw, err := json.Marshal(canonical)
	if err != nil {
		return nil, "", ErrInvalid
	}
	if len(raw) > maxSecretBytes {
		return nil, "", fmt.Errorf("secret exceeds %d bytes", maxSecretBytes)
	}
	sum := sha256.Sum256(raw)
	return raw, "sha256:" + hex.EncodeToString(sum[:]), nil
}

func validateSecretShape(typ string, secret map[string]string) error {
	switch typ {
	case TypeKubernetes:
		v := strings.TrimSpace(secret["kubeconfig"])
		if v == "" {
			return fmt.Errorf("kubeconfig is required")
		}
		if !utf8.ValidString(v) {
			return fmt.Errorf("kubeconfig must be UTF-8")
		}
	case TypeSSHPrivateKey:
		v := strings.TrimSpace(secret["privateKey"])
		if v == "" {
			return fmt.Errorf("privateKey is required")
		}
	case TypeToken:
		v := strings.TrimSpace(secret["token"])
		if len(v) < minTokenLen {
			return fmt.Errorf("token is required")
		}
	case TypeWebhookSecret:
		v := strings.TrimSpace(secret["secret"])
		if len(v) < minTokenLen {
			return fmt.Errorf("secret is required")
		}
	case TypeProvider:
		v := strings.TrimSpace(firstNonEmpty(secret["token"], secret["apiKey"]))
		if len(v) < minTokenLen {
			return fmt.Errorf("token is required")
		}
	default:
		return fmt.Errorf("unknown credential type")
	}
	return nil
}

// TestPayload decrypts nothing: it inspects already-decrypted canonical JSON.
// The result reason never includes secret material.
func TestPayload(typ string, plaintext []byte) (status, reason string) {
	var secret map[string]string
	if err := json.Unmarshal(plaintext, &secret); err != nil {
		return TestFailed, "payload is not a typed secret object"
	}
	if err := validateSecretShape(typ, secret); err != nil {
		return TestFailed, safeTestReason(err)
	}
	switch typ {
	case TypeKubernetes:
		cfg := strings.ToLower(secret["kubeconfig"])
		if !strings.Contains(cfg, "apiversion") || (!strings.Contains(cfg, "clusters") && !strings.Contains(cfg, "kind: config")) {
			return TestFailed, "kubeconfig shape is invalid"
		}
	case TypeSSHPrivateKey:
		key := secret["privateKey"]
		if !strings.Contains(key, "BEGIN") || !strings.Contains(key, "PRIVATE KEY") {
			return TestFailed, "private key is not PEM"
		}
	}
	return TestPassed, "payload shape is valid"
}

func safeTestReason(err error) string {
	if err == nil {
		return "payload shape is valid"
	}
	msg := err.Error()
	if strings.Contains(strings.ToLower(msg), "required") || strings.Contains(msg, "UTF-8") || strings.Contains(msg, "type") {
		return msg
	}
	return "payload shape is invalid"
}

func sanitizeTags(in []string) ([]string, error) {
	if in == nil {
		return []string{}, nil
	}
	if len(in) > maxTags {
		return nil, fmt.Errorf("at most %d tags are allowed", maxTags)
	}
	out := make([]string, 0, len(in))
	seen := map[string]struct{}{}
	for _, tag := range in {
		tag = strings.TrimSpace(strings.ToLower(tag))
		if tag == "" {
			continue
		}
		if len(tag) > maxTagLen {
			return nil, fmt.Errorf("tag exceeds %d characters", maxTagLen)
		}
		for _, r := range tag {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return nil, fmt.Errorf("tags must be lowercase letters, digits, or hyphen")
			}
		}
		if _, ok := seen[tag]; ok {
			continue
		}
		seen[tag] = struct{}{}
		out = append(out, tag)
	}
	return out, nil
}

var forbiddenMetaKeys = map[string]struct{}{
	"kubeconfig": {}, "privatekey": {}, "private_key": {}, "token": {},
	"secret": {}, "password": {}, "passphrase": {}, "apikey": {}, "api_key": {},
	"authorization": {}, "ciphertext": {}, "dek": {}, "dekenvelope": {},
	"dek_envelope": {}, "plaintext": {},
}

func sanitizeMetadata(in map[string]string) (map[string]string, error) {
	if in == nil {
		return map[string]string{}, nil
	}
	if len(in) > maxMetaKeys {
		return nil, fmt.Errorf("at most %d metadata fields are allowed", maxMetaKeys)
	}
	out := map[string]string{}
	for k, v := range in {
		k = strings.TrimSpace(k)
		if k == "" {
			continue
		}
		norm := strings.ToLower(strings.ReplaceAll(k, "-", "_"))
		if _, ban := forbiddenMetaKeys[norm]; ban {
			return nil, fmt.Errorf("metadata cannot store secret fields")
		}
		v = strings.TrimSpace(v)
		if len(k) > maxMetaLen || len(v) > maxMetaLen {
			return nil, fmt.Errorf("metadata fields must be at most %d characters", maxMetaLen)
		}
		out[k] = v
	}
	return out, nil
}

func normalizeDisplayName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxDisplayName {
		return "", fmt.Errorf("displayName is required and must be at most %d characters", maxDisplayName)
	}
	return name, nil
}

func parseExpires(raw string) (*time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, fmt.Errorf("expiresAt must be RFC3339")
	}
	utc := t.UTC()
	return &utc, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func deriveSSHKeyType(privateKey string) string {
	upper := strings.ToUpper(privateKey)
	switch {
	case strings.Contains(upper, "OPENSSH PRIVATE KEY"):
		return "openssh"
	case strings.Contains(upper, "RSA PRIVATE KEY"):
		return "rsa"
	case strings.Contains(upper, "EC PRIVATE KEY"):
		return "ec"
	case strings.Contains(upper, "PRIVATE KEY"):
		return "pkcs8"
	default:
		return ""
	}
}
