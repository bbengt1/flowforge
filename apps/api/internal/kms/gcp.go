package kms

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
)

const (
	envGCPKey       = "KMS_GCP_KEY_NAME"
	envGCPToken     = "KMS_GCP_ACCESS_TOKEN"
	envGCPTokenFile = "KMS_GCP_TOKEN_FILE"
	envGCPEndpoint  = "KMS_GCP_ENDPOINT"

	defaultGCPEndpoint = "https://cloudkms.googleapis.com"
)

// projects/{project}/locations/{loc}/keyRings/{ring}/cryptoKeys/{key}
// with an optional cryptoKeyVersions/{n} suffix.
var gcpKeyName = regexp.MustCompile(`^projects/[A-Za-z0-9_-]{1,64}/locations/[A-Za-z0-9_-]{1,64}/keyRings/[A-Za-z0-9_-]{1,64}/cryptoKeys/[A-Za-z0-9_-]{1,64}(/cryptoKeyVersions/[0-9]{1,20})?$`)

type gcpProvider struct {
	endpoint string
	keyID    string
	token    string
	client   *http.Client
}

func (p *gcpProvider) Name() string  { return "gcp" }
func (p *gcpProvider) KeyID() string { return p.keyID }

func (p *gcpProvider) Wrap(ctx context.Context, kek []byte) ([]byte, error) {
	if len(kek) != 32 {
		return nil, ErrUnavailable
	}
	body, err := postJSON(ctx, p.client, p.endpoint+"/v1/"+p.keyID+":encrypt", p.token, nil, map[string]string{
		"plaintext":                   base64.StdEncoding.EncodeToString(kek),
		"additionalAuthenticatedData": base64.StdEncoding.EncodeToString([]byte(Purpose)),
	})
	if err != nil {
		return nil, ErrUnavailable
	}
	var resp struct {
		Ciphertext string `json:"ciphertext"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, ErrUnavailable
	}
	ct, err := base64.StdEncoding.DecodeString(resp.Ciphertext)
	if err != nil || len(ct) == 0 {
		return nil, ErrUnavailable
	}
	return ct, nil
}

func (p *gcpProvider) Unwrap(ctx context.Context, keyID string, wrapped []byte) ([]byte, error) {
	if keyID == "" {
		keyID = p.keyID
	}
	if !gcpKeyName.MatchString(keyID) || len(wrapped) == 0 {
		return nil, ErrUnavailable
	}
	body, err := postJSON(ctx, p.client, p.endpoint+"/v1/"+keyID+":decrypt", p.token, nil, map[string]string{
		"ciphertext":                  base64.StdEncoding.EncodeToString(wrapped),
		"additionalAuthenticatedData": base64.StdEncoding.EncodeToString([]byte(Purpose)),
	})
	if err != nil {
		return nil, ErrUnavailable
	}
	var resp struct {
		Plaintext string `json:"plaintext"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, ErrUnavailable
	}
	kek, err := base64.StdEncoding.DecodeString(resp.Plaintext)
	if err != nil {
		return nil, ErrUnavailable
	}
	return kek, nil
}

func openGCP(productionLocked bool) (*gcpProvider, error) {
	keyID := firstEnv(envGCPKey, EnvKeyID)
	if !gcpKeyName.MatchString(keyID) {
		return nil, errStringf("%s or %s is required", envGCPKey, EnvKeyID)
	}
	token, err := oneSecret(getenv(envGCPToken), envGCPToken, getenv(envGCPTokenFile), envGCPTokenFile)
	if err != nil {
		return nil, err
	}
	endpoint := getenv(envGCPEndpoint)
	if endpoint == "" {
		endpoint = defaultGCPEndpoint
	}
	origin, err := parseOrigin(endpoint, envGCPEndpoint, productionLocked)
	if err != nil {
		return nil, err
	}
	return &gcpProvider{endpoint: origin, keyID: keyID, token: token, client: newHTTPClient()}, nil
}
