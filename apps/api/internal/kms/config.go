package kms

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
)

// Wrapped-KEK environment. Values are EncodeBlob text, never plaintext.
const (
	EnvWrapped         = "CREDENTIAL_KEK_WRAPPED"
	EnvWrappedFile     = "CREDENTIAL_KEK_WRAPPED_FILE"
	EnvPreviousWrapped = "CREDENTIAL_KEK_PREVIOUS_WRAPPED"
	EnvPreviousFile    = "CREDENTIAL_KEK_PREVIOUS_WRAPPED_FILE"
	EnvKEKID           = "CREDENTIAL_KEK_ID"
	EnvPreviousID      = "CREDENTIAL_KEK_PREVIOUS_ID"
	EnvPlainKEK        = "CREDENTIAL_KEK"
	EnvPlainKEKFile    = "CREDENTIAL_KEK_FILE"
)

var awsRegion = regexp.MustCompile(`^[a-z0-9-]{1,32}$`)

// EnvNames lists every variable this package reads. Tests clear them.
// Values are names only.
func EnvNames() []string {
	return []string{
		EnvProvider, EnvKeyID,
		envAWSRegion, envAWSKeyID, envAWSAccess, envAWSSecret, envAWSToken, envAWSEndpoint,
		envGCPKey, envGCPToken, envGCPTokenFile, envGCPEndpoint,
		envAzureVault, envAzureKey, envAzureVersion, envAzureToken, envAzureTokenFile, envAzureAlg, envAzureAPI,
		envVaultAddr, envVaultToken, envVaultTokenFile, envVaultKey, envVaultMount, envVaultNamespace,
		EnvWrapped, EnvWrappedFile, EnvPreviousWrapped, EnvPreviousFile, EnvPreviousID,
	}
}

// Material is unwrapped KEK bytes plus the key references stored on
// ciphertext rows. Callers must not log the byte slices.
type Material struct {
	KEK        []byte
	ID         string
	Previous   []byte
	PreviousID string
}

// Open returns the configured provider. A nil provider and a nil error
// means KMS is unset. Partial configuration is an error in every
// environment. productionLocked rejects non-loopback http endpoints.
func Open(productionLocked bool) (Provider, error) {
	provider := strings.ToLower(strings.TrimSpace(os.Getenv(EnvProvider)))
	if provider == "" {
		if envIntent() {
			return nil, fmt.Errorf("%s is required", EnvProvider)
		}
		return nil, nil
	}
	switch provider {
	case "aws":
		return openAWS(productionLocked)
	case "gcp":
		return openGCP(productionLocked)
	case "azure":
		return openAzure(productionLocked)
	case "vault":
		return openVault(productionLocked)
	default:
		return nil, fmt.Errorf("%s must be aws, gcp, azure, or vault", EnvProvider)
	}
}

// Resolve unwraps the active KEK and the optional previous KEK.
// It does not read CREDENTIAL_KEK. A failed unwrap is terminal.
func Resolve(ctx context.Context, p Provider) (Material, error) {
	if p == nil {
		return Material{}, fmt.Errorf("%s is required", EnvProvider)
	}
	if strings.TrimSpace(os.Getenv(EnvPlainKEK)) != "" || strings.TrimSpace(os.Getenv(EnvPlainKEKFile)) != "" {
		return Material{}, fmt.Errorf("%s and %s must be unset when %s is set", EnvPlainKEK, EnvPlainKEKFile, EnvProvider)
	}
	blob, err := readWrapped(EnvWrapped, EnvWrappedFile)
	if err != nil {
		return Material{}, err
	}
	if blob == "" {
		return Material{}, fmt.Errorf("%s or %s is required", EnvWrapped, EnvWrappedFile)
	}
	kek, err := UnwrapBlob(ctx, p, blob)
	if err != nil {
		return Material{}, fmt.Errorf("unwrap %s: %w", EnvWrapped, err)
	}
	id := strings.TrimSpace(os.Getenv(EnvKEKID))
	if id == "" {
		id = DefaultKeyReference(p.Name(), p.KeyID())
	}
	if err := validReference(id); err != nil {
		Wipe(kek)
		return Material{}, err
	}
	prevBlob, err := readWrapped(EnvPreviousWrapped, EnvPreviousFile)
	if err != nil {
		Wipe(kek)
		return Material{}, err
	}
	prevID := strings.TrimSpace(os.Getenv(EnvPreviousID))
	if prevBlob == "" && prevID == "" {
		return Material{KEK: kek, ID: id}, nil
	}
	if prevBlob == "" || prevID == "" {
		Wipe(kek)
		return Material{}, fmt.Errorf("%s and %s are required together", EnvPreviousWrapped, EnvPreviousID)
	}
	if err := validReference(prevID); err != nil {
		Wipe(kek)
		return Material{}, err
	}
	if prevID == id {
		Wipe(kek)
		return Material{}, fmt.Errorf("%s must differ from %s", EnvPreviousID, EnvKEKID)
	}
	prev, err := UnwrapBlob(ctx, p, prevBlob)
	if err != nil {
		Wipe(kek)
		return Material{}, fmt.Errorf("unwrap %s: %w", EnvPreviousWrapped, err)
	}
	return Material{KEK: kek, ID: id, Previous: prev, PreviousID: prevID}, nil
}

func envIntent() bool {
	for _, name := range EnvNames() {
		if name == EnvProvider {
			continue
		}
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return true
		}
	}
	return false
}

// CurrentWrapped is the active at-rest blob (ciphertext only).
func CurrentWrapped() (string, error) {
	return readWrapped(EnvWrapped, EnvWrappedFile)
}

func readWrapped(envName, fileEnv string) (string, error) {
	val := strings.TrimSpace(os.Getenv(envName))
	path := strings.TrimSpace(os.Getenv(fileEnv))
	if val != "" && path != "" {
		return "", fmt.Errorf("%s and %s are mutually exclusive", envName, fileEnv)
	}
	if path == "" {
		return val, nil
	}
	return readSecretFile(path, fileEnv)
}

func oneSecret(val, envName, path, fileEnv string) (string, error) {
	val = strings.TrimSpace(val)
	path = strings.TrimSpace(path)
	if val != "" && path != "" {
		return "", fmt.Errorf("%s and %s are mutually exclusive", envName, fileEnv)
	}
	if path != "" {
		return readSecretFile(path, fileEnv)
	}
	if val == "" {
		return "", fmt.Errorf("%s or %s is required", envName, fileEnv)
	}
	if err := singleLine(val, envName); err != nil {
		return "", err
	}
	return val, nil
}

func readSecretFile(path, envName string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("%s: %w", envName, err)
	}
	if len(data) > maxBlobRunes {
		return "", fmt.Errorf("%s is invalid", envName)
	}
	s := strings.TrimSpace(string(data))
	if s == "" || strings.ContainsAny(s, "\r\n") {
		return "", fmt.Errorf("%s is invalid", envName)
	}
	return s, nil
}

func validReference(id string) error {
	if id == "" || len(id) > 200 {
		return fmt.Errorf("%s must be 1 to 200 characters", EnvKEKID)
	}
	for _, r := range id {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s must be 1 to 200 characters", EnvKEKID)
		}
	}
	return nil
}

func firstEnv(names ...string) string {
	for _, name := range names {
		if v := strings.TrimSpace(os.Getenv(name)); v != "" {
			return v
		}
	}
	return ""
}

func getenv(name string) string {
	return strings.TrimSpace(os.Getenv(name))
}

func errStringf(format string, args ...any) error {
	return fmt.Errorf(format, args...)
}
