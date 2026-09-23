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
	envAzureVault     = "KMS_AZURE_VAULT_URL"
	envAzureKey       = "KMS_AZURE_KEY_NAME"
	envAzureVersion   = "KMS_AZURE_KEY_VERSION"
	envAzureToken     = "KMS_AZURE_ACCESS_TOKEN"
	envAzureTokenFile = "KMS_AZURE_TOKEN_FILE"
	envAzureAlg       = "KMS_AZURE_WRAP_ALG"
	envAzureAPI       = "KMS_AZURE_API_VERSION"

	defaultAzureAlg = "RSA-OAEP-256"
	defaultAzureAPI = "7.4"
)

var (
	azureName    = regexp.MustCompile(`^[A-Za-z0-9-]{1,127}$`)
	azureVersion = regexp.MustCompile(`^[A-Za-z0-9]{1,32}$`)
	azureAPI     = regexp.MustCompile(`^[0-9]{1,2}\.[0-9]{1,2}$`)
	azureHosts   = []string{
		".vault.azure.net",
		".vault.azure.cn",
		".vault.usgovcloudapi.net",
		".vault.microsoftazure.de",
		".vault.azure.us",
	}
)

type azureProvider struct {
	vaultURL string
	keyID    string
	alg      string
	api      string
	token    string
	client   *http.Client
}

func (p *azureProvider) Name() string  { return "azure" }
func (p *azureProvider) KeyID() string { return p.keyID }

func (p *azureProvider) Wrap(ctx context.Context, kek []byte) ([]byte, error) {
	if len(kek) != 32 {
		return nil, ErrUnavailable
	}
	endpoint, err := p.wrapURL(p.keyID, "wrapkey")
	if err != nil {
		return nil, ErrUnavailable
	}
	body, err := postJSON(ctx, p.client, endpoint, p.token, nil, map[string]string{
		"alg":   p.alg,
		"value": base64.RawURLEncoding.EncodeToString(kek),
	})
	if err != nil {
		return nil, ErrUnavailable
	}
	var resp struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, ErrUnavailable
	}
	ct, err := base64.RawURLEncoding.DecodeString(resp.Value)
	if err != nil || len(ct) == 0 {
		return nil, ErrUnavailable
	}
	return ct, nil
}

func (p *azureProvider) Unwrap(ctx context.Context, keyID string, wrapped []byte) ([]byte, error) {
	if keyID == "" {
		keyID = p.keyID
	}
	endpoint, err := p.wrapURL(keyID, "unwrapkey")
	if err != nil || len(wrapped) == 0 {
		return nil, ErrUnavailable
	}
	body, err := postJSON(ctx, p.client, endpoint, p.token, nil, map[string]string{
		"alg":   p.alg,
		"value": base64.RawURLEncoding.EncodeToString(wrapped),
	})
	if err != nil {
		return nil, ErrUnavailable
	}
	var resp struct {
		Value string `json:"value"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, ErrUnavailable
	}
	kek, err := base64.RawURLEncoding.DecodeString(resp.Value)
	if err != nil {
		return nil, ErrUnavailable
	}
	return kek, nil
}

func (p *azureProvider) wrapURL(keyID, op string) (string, error) {
	name, version, err := splitAzureKey(keyID)
	if err != nil {
		return "", err
	}
	u := p.vaultURL + "/keys/" + url.PathEscape(name)
	if version != "" {
		u += "/" + url.PathEscape(version)
	}
	return u + "/" + op + "?api-version=" + url.QueryEscape(p.api), nil
}

func openAzure(productionLocked bool) (*azureProvider, error) {
	origin, err := parseOrigin(getenv(envAzureVault), envAzureVault, productionLocked)
	if err != nil {
		return nil, err
	}
	if origin == "" {
		return nil, errStringf("%s is required", envAzureVault)
	}
	if err := azureHostAllowed(origin, productionLocked); err != nil {
		return nil, err
	}
	name := firstEnv(envAzureKey, EnvKeyID)
	version := strings.TrimSpace(getenv(envAzureVersion))
	keyID := name
	if version != "" {
		keyID = name + "/" + version
	}
	if _, _, err := splitAzureKey(keyID); err != nil {
		return nil, errStringf("%s or %s is required", envAzureKey, EnvKeyID)
	}
	alg := strings.TrimSpace(getenv(envAzureAlg))
	if alg == "" {
		alg = defaultAzureAlg
	}
	switch alg {
	case "RSA-OAEP-256", "A256KW":
	default:
		return nil, errStringf("%s must be RSA-OAEP-256 or A256KW", envAzureAlg)
	}
	api := strings.TrimSpace(getenv(envAzureAPI))
	if api == "" {
		api = defaultAzureAPI
	}
	if !azureAPI.MatchString(api) {
		return nil, errStringf("%s is invalid", envAzureAPI)
	}
	token, err := oneSecret(getenv(envAzureToken), envAzureToken, getenv(envAzureTokenFile), envAzureTokenFile)
	if err != nil {
		return nil, err
	}
	return &azureProvider{
		vaultURL: origin,
		keyID:    keyID,
		alg:      alg,
		api:      api,
		token:    token,
		client:   newHTTPClient(),
	}, nil
}

func splitAzureKey(id string) (name, version string, err error) {
	parts := strings.Split(id, "/")
	switch len(parts) {
	case 1:
		name = parts[0]
	case 2:
		name, version = parts[0], parts[1]
	default:
		return "", "", ErrUnavailable
	}
	if !azureName.MatchString(name) || (version != "" && !azureVersion.MatchString(version)) {
		return "", "", ErrUnavailable
	}
	return name, version, nil
}

func azureHostAllowed(origin string, productionLocked bool) error {
	u, err := url.Parse(origin)
	if err != nil {
		return errStringf("%s must be an https origin", envAzureVault)
	}
	host := strings.ToLower(u.Hostname())
	if !productionLocked && loopbackHost(host) {
		return nil
	}
	for _, suffix := range azureHosts {
		if strings.HasSuffix(host, suffix) && len(host) > len(suffix) {
			return nil
		}
	}
	return errStringf("%s host is not an Azure Key Vault host", envAzureVault)
}
