package kms

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const (
	envVaultAddr      = "KMS_VAULT_ADDR"
	envVaultToken     = "KMS_VAULT_TOKEN"
	envVaultTokenFile = "KMS_VAULT_TOKEN_FILE"
	envVaultKey       = "KMS_VAULT_KEY_NAME"
	envVaultMount     = "KMS_VAULT_MOUNT"
	envVaultNamespace = "KMS_VAULT_NAMESPACE"

	defaultVaultMount = "transit"
)

var vaultName = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

type vaultProvider struct {
	addr      string
	mount     string
	keyID     string
	token     string
	namespace string
	client    *http.Client
}

func (p *vaultProvider) Name() string  { return "vault" }
func (p *vaultProvider) KeyID() string { return p.keyID }

func (p *vaultProvider) Wrap(ctx context.Context, kek []byte) ([]byte, error) {
	if len(kek) != 32 {
		return nil, ErrUnavailable
	}
	endpoint, err := p.opURL(p.keyID, "encrypt")
	if err != nil {
		return nil, ErrUnavailable
	}
	body, err := postJSON(ctx, p.client, endpoint, "", p.headers(), map[string]string{
		"plaintext": base64.StdEncoding.EncodeToString(kek),
		"context":   base64.StdEncoding.EncodeToString([]byte(Purpose)),
	})
	if err != nil {
		return nil, ErrUnavailable
	}
	var resp struct {
		Data struct {
			Ciphertext string `json:"ciphertext"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil || resp.Data.Ciphertext == "" {
		return nil, ErrUnavailable
	}
	if !strings.HasPrefix(resp.Data.Ciphertext, "vault:v") {
		return nil, ErrUnavailable
	}
	return []byte(resp.Data.Ciphertext), nil
}

func (p *vaultProvider) Unwrap(ctx context.Context, keyID string, wrapped []byte) ([]byte, error) {
	if keyID == "" {
		keyID = p.keyID
	}
	endpoint, err := p.opURL(keyID, "decrypt")
	if err != nil || len(wrapped) == 0 {
		return nil, ErrUnavailable
	}
	body, err := postJSON(ctx, p.client, endpoint, "", p.headers(), map[string]string{
		"ciphertext": string(wrapped),
		"context":    base64.StdEncoding.EncodeToString([]byte(Purpose)),
	})
	if err != nil {
		return nil, ErrUnavailable
	}
	var resp struct {
		Data struct {
			Plaintext string `json:"plaintext"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, ErrUnavailable
	}
	kek, err := base64.StdEncoding.DecodeString(resp.Data.Plaintext)
	if err != nil {
		return nil, ErrUnavailable
	}
	return kek, nil
}

func (p *vaultProvider) headers() map[string]string {
	h := map[string]string{"X-Vault-Token": p.token}
	if p.namespace != "" {
		h["X-Vault-Namespace"] = p.namespace
	}
	return h
}

func (p *vaultProvider) opURL(keyID, op string) (string, error) {
	if !vaultName.MatchString(keyID) || !vaultName.MatchString(p.mount) {
		return "", ErrUnavailable
	}
	return p.addr + "/v1/" + url.PathEscape(p.mount) + "/" + op + "/" + url.PathEscape(keyID), nil
}

func openVault(productionLocked bool) (*vaultProvider, error) {
	origin, err := parseOrigin(getenv(envVaultAddr), envVaultAddr, productionLocked)
	if err != nil {
		return nil, err
	}
	if origin == "" {
		return nil, errStringf("%s is required", envVaultAddr)
	}
	keyID := firstEnv(envVaultKey, EnvKeyID)
	if !vaultName.MatchString(keyID) {
		return nil, errStringf("%s or %s is required", envVaultKey, EnvKeyID)
	}
	mount := strings.TrimSpace(getenv(envVaultMount))
	if mount == "" {
		mount = defaultVaultMount
	}
	if !vaultName.MatchString(mount) {
		return nil, errStringf("%s is invalid", envVaultMount)
	}
	namespace := strings.TrimSpace(getenv(envVaultNamespace))
	if namespace != "" && (strings.ContainsAny(namespace, "\r\n ") || len(namespace) > 256) {
		return nil, errStringf("%s is invalid", envVaultNamespace)
	}
	token, err := oneSecret(getenv(envVaultToken), envVaultToken, getenv(envVaultTokenFile), envVaultTokenFile)
	if err != nil {
		return nil, err
	}
	return &vaultProvider{
		addr:      origin,
		mount:     mount,
		keyID:     keyID,
		token:     token,
		namespace: namespace,
		client:    newHTTPClient(),
	}, nil
}
