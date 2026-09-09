package scripts

import (
	"net/http"
	"strings"
)

// Allowlisted runtime environment keys. Anything else is denied, including
// AWS_*, KUBECONFIG, Docker socket hints, and plaintext credential names.
var allowedRuntimeEnv = map[string]bool{
	"FLOWFORGE_CORRELATION_ID":     true,
	"FLOWFORGE_LANGUAGE":           true,
	"FLOWFORGE_ENTRYPOINT":         true,
	"FLOWFORGE_ARTIFACT_DIGEST":    true,
	"FLOWFORGE_RUNTIME_PROFILE_ID": true,
	"FLOWFORGE_HANDLE_IDS":         true,
	"FLOWFORGE_IDEMPOTENCY_KEY":    true,
}

var deniedEnvNames = []string{
	"AWS_", "KUBE", "DOCKER", "SECRET", "TOKEN", "PASSWORD", "PASSWD",
	"CREDENTIAL", "PRIVATE", "KUBECONFIG", "SSH_", "GITHUB_", "BEARER",
	"AUTHORIZATION", "API_KEY", "APIKEY",
}

// AllowedRuntimeEnv is the Chloe / worker allowlist.
func AllowedRuntimeEnv() []string {
	return []string{
		"FLOWFORGE_CORRELATION_ID",
		"FLOWFORGE_LANGUAGE",
		"FLOWFORGE_ENTRYPOINT",
		"FLOWFORGE_ARTIFACT_DIGEST",
		"FLOWFORGE_RUNTIME_PROFILE_ID",
		"FLOWFORGE_HANDLE_IDS",
		"FLOWFORGE_IDEMPOTENCY_KEY",
	}
}

// RuntimeEnv builds the allowlisted process environment. Extra keys fail closed.
func RuntimeEnv(req Request, handleIDs []string) (map[string]string, error) {
	out := map[string]string{}
	put := func(key, value string) error {
		if err := validateRuntimeEnvPair(key, value); err != nil {
			return err
		}
		if strings.TrimSpace(value) == "" {
			return nil
		}
		out[key] = value
		return nil
	}
	if err := put("FLOWFORGE_CORRELATION_ID", strings.TrimSpace(req.CorrelationID)); err != nil {
		return nil, err
	}
	if err := put("FLOWFORGE_LANGUAGE", languageOf(req)); err != nil {
		return nil, err
	}
	if err := put("FLOWFORGE_ENTRYPOINT", firstNonEmpty(req.Entrypoint, req.Artifact.Entrypoint)); err != nil {
		return nil, err
	}
	if err := put("FLOWFORGE_ARTIFACT_DIGEST", strings.TrimSpace(req.Artifact.Digest)); err != nil {
		return nil, err
	}
	if err := put("FLOWFORGE_RUNTIME_PROFILE_ID", firstNonEmpty(req.RuntimeProfileID, req.Artifact.RuntimeProfileID)); err != nil {
		return nil, err
	}
	if len(handleIDs) > 0 {
		if err := put("FLOWFORGE_HANDLE_IDS", strings.Join(handleIDs, ",")); err != nil {
			return nil, err
		}
	}
	if key := strings.TrimSpace(req.IdempotencyKey); key != "" {
		if err := put("FLOWFORGE_IDEMPOTENCY_KEY", key); err != nil {
			return nil, err
		}
	}
	for k, v := range req.ExtraEnv {
		if !allowedRuntimeEnv[k] {
			return nil, engineError(CodeEnvDenied, "runtime environment key is not allowlisted.", http.StatusForbidden)
		}
		if err := put(k, v); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func validateRuntimeEnvPair(key, value string) error {
	if !allowedRuntimeEnv[key] {
		return engineError(CodeEnvDenied, "runtime environment key is not allowlisted.", http.StatusForbidden)
	}
	upper := strings.ToUpper(key)
	for _, deny := range deniedEnvNames {
		if strings.Contains(upper, deny) && !allowedRuntimeEnv[key] {
			return engineError(CodeEnvDenied, "runtime environment key is not allowlisted.", http.StatusForbidden)
		}
	}
	if irredactableSecret([]byte(value)) {
		return engineError(CodeSecretForbidden, "plaintext credentials cannot be injected into the runner environment.", http.StatusBadRequest)
	}
	if _, changed := redactTokens(value); changed {
		return engineError(CodeSecretForbidden, "plaintext credentials cannot be injected into the runner environment.", http.StatusBadRequest)
	}
	return nil
}
