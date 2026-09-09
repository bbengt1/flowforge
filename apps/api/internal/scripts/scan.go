package scripts

import (
	"bytes"
	"net/http"
	"regexp"
	"strings"
)

// Secret patterns match the E5.3 artifact scanner. scripts must not import
// artifact (that package pulls vault → wfstore → workflow and would cycle).
var (
	pemPrivateKey = regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----`)
	kubeconfigDoc = regexp.MustCompile(`(?is)apiVersion:\s*v1[\s\S]{0,400}kind:\s*Config[\s\S]{0,800}(users:|user:)`)
	k8sSecretDoc  = regexp.MustCompile(`(?is)kind:\s*Secret[\s\S]{0,400}(data:|stringData:)`)
	awsSecret     = regexp.MustCompile(`(?i)aws_secret_access_key\s*[=:]\s*\S+`)
	githubToken   = regexp.MustCompile(`(?i)\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b`)
	bearerToken   = regexp.MustCompile(`(?i)\bbearer\s+[A-Za-z0-9\-._~+/]+=*`)
	jwtToken      = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
)

// ScanSource inspects authored source before it is packaged. Irredactable
// secrets fail closed; isolated token-shaped strings are treated as forbidden
// in published source (source is versioned YAML, not a redacted log).
func ScanSource(source string) error {
	if strings.TrimSpace(source) == "" {
		return engineError(CodeInvalidSource, "source is required.", http.StatusBadRequest)
	}
	if irredactableSecret([]byte(source)) {
		return engineError(CodeSecretForbidden, "Secret material is not allowed in script source.", http.StatusBadRequest)
	}
	if _, changed := redactTokens(source); changed {
		return engineError(CodeSecretForbidden, "Secret material is not allowed in script source.", http.StatusBadRequest)
	}
	return nil
}

// ScanStatusFor reports the persistable scan status after a closed check.
func ScanStatusFor(source string) (status string, err error) {
	if err := ScanSource(source); err != nil {
		return ScanFailed, err
	}
	return ScanClean, nil
}

func irredactableSecret(payload []byte) bool {
	if pemPrivateKey.Match(payload) || kubeconfigDoc.Match(payload) || k8sSecretDoc.Match(payload) || awsSecret.Match(payload) {
		return true
	}
	lower := bytes.ToLower(payload)
	if bytes.Contains(lower, []byte("dek_envelope")) || bytes.Contains(lower, []byte("ciphertext")) {
		if bytes.Contains(lower, []byte("credential")) || bytes.Contains(lower, []byte("kubeconfig")) {
			return true
		}
	}
	return false
}

func redactTokens(source string) (string, bool) {
	s := source
	s = bearerToken.ReplaceAllString(s, "[redacted]")
	s = githubToken.ReplaceAllString(s, "[redacted]")
	s = jwtToken.ReplaceAllString(s, "[redacted]")
	return s, s != source
}
